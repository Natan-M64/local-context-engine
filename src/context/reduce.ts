import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js"
import type { ContextBudget } from "./budget.js"
import { CharacterTokenEstimator, classifyToolEvidence, estimateRequestTokens, type TokenEstimator } from "./measure.js"
import type { ContentStore } from "../eviction/store.js"

export type ReductionClass = "SAFE" | "LIVE_EVIDENCE" | "HISTORICAL_ARGUMENT" | "CAUTIOUS" | "PROTECTED"

export interface EvictionRecord {
  messageIndex: number
  handle: string
  originalTokens: number
  retainedTokens: number
  reductionClass: "SAFE" | "LIVE_EVIDENCE" | "HISTORICAL_ARGUMENT"
}

export interface ReductionResult {
  request: ChatCompletionRequest
  beforeTokens: number
  afterTokens: number
  reclaimedTokens: number
  evictions: EvictionRecord[]
  fits: boolean
}

export class ContextBudgetExceededError extends Error {
  constructor(readonly result: ReductionResult, readonly budget: ContextBudget) {
    super(`request requires ${result.afterTokens} tokens but safe input budget is ${budget.safeInput}`)
    this.name = "ContextBudgetExceededError"
  }
}

function contentString(message: ChatMessage): string | undefined {
  return typeof message.content === "string" ? message.content : undefined
}

function preview(content: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return ""
  if (content.length <= maxCharacters) return content
  const head = Math.ceil(maxCharacters * 0.7)
  const tail = Math.floor(maxCharacters * 0.3)
  return `${content.slice(0, head)}\n...[archived]...\n${content.slice(-tail)}`
}

function archivedContent(handle: string, bytes: number, tokens: number, retainedPreview: string): string {
  return [
    "[Tool output archived]",
    `Handle: ${handle}`,
    `Original size: ${bytes} bytes (${tokens} estimated tokens)`,
    "Preview:",
    retainedPreview,
  ].join("\n")
}

function liveEvidenceContent(handle: string, originalTokens: number, retainedPreview: string, estimator: TokenEstimator): string {
  return [
    "[Current tool output partially archived]",
    `Handle: ${handle}`,
    `Original estimated tokens: ${originalTokens}`,
    `Preserved estimated tokens: ${estimator.estimateText(retainedPreview)}`,
    "",
    "--- BEGIN EXCERPT ---",
    retainedPreview,
    "--- END EXCERPT ---",
  ].join("\n")
}

function liveEvidenceContentWithoutExcerpt(handle: string, originalTokens: number): string {
  return [
    "[Current tool output partially archived]",
    `Handle: ${handle}`,
    `Original estimated tokens: ${originalTokens}`,
    "Preserved estimated tokens: 0",
    "",
    "--- BEGIN EXCERPT ---",
    "--- END EXCERPT ---",
  ].join("\n")
}

function compactArchivedContent(handle: string): string {
  return `[Content archived]\nHandle: ${handle}`
}

function archivedArgumentContent(handle: string): string {
  return JSON.stringify({
    _archived: true,
    handle,
  })
}

function parseValidJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === "object"
  } catch {
    return false
  }
}

export async function reduceRequestToBudget(
  request: ChatCompletionRequest,
  budget: ContextBudget,
  store: ContentStore,
  options: {
    estimator?: TokenEstimator
    measureRequest?: (request: ChatCompletionRequest) => Promise<{ tokens: number }>
    previewCharacters?: number
    minimumPreviewCharacters?: number
    emergencyPreviewCharacters?: number
    compactArchiveMetadata?: boolean
    targetTokens?: number
    liveEvidenceSafetyMarginTokens?: number
  } = {},
): Promise<ReductionResult> {
  const estimator = options.estimator ?? new CharacterTokenEstimator()
  const measure = options.measureRequest ?? (async (req) => ({ tokens: estimateRequestTokens(req, estimator) }))
  const previewCharacters = options.previewCharacters ?? 1_200
  const minimumPreviewCharacters = Math.min(options.minimumPreviewCharacters ?? 160, previewCharacters)
  const emergencyPreviewCharacters = Math.min(options.emergencyPreviewCharacters ?? 0, minimumPreviewCharacters)
  const targetTokens = Math.max(1, Math.min(Math.floor(options.targetTokens ?? budget.safeInput), budget.safeInput))
  const reduced = structuredClone(request)
  const beforeMeasurement = await measure(reduced)
  const beforeTokens = beforeMeasurement.tokens
  let afterTokens = beforeTokens
  const evictions: EvictionRecord[] = []

  if (afterTokens > targetTokens) {
    const allToolCandidates = reduced.messages
      .map((message, messageIndex) => ({ message, messageIndex, content: contentString(message) }))
      .filter((candidate): candidate is { message: ChatMessage; messageIndex: number; content: string } =>
        candidate.message.role === "tool" && candidate.content !== undefined,
      )
    const evidence = classifyToolEvidence(reduced.messages)
    const safeIndexes = new Set(evidence.safeMessageIndexes)
    const liveEvidenceIndexes = new Set(evidence.liveEvidenceMessageIndexes)
    const historicalAssistantIndexes = new Set(evidence.historicalAssistantMessageIndexes)
    const candidates = allToolCandidates
      .filter((candidate) => safeIndexes.has(candidate.messageIndex))
      .sort((left, right) => {
        const age = left.messageIndex - right.messageIndex
        if (age !== 0) return age
        return right.content.length - left.content.length
      })

    const archived = [] as Array<{
      candidate: (typeof candidates)[number]
      originalContent: string
      handle: string
      bytes: number
      originalTokens: number
      record: EvictionRecord
    }>
    for (const candidate of candidates) {
      if (afterTokens <= targetTokens) break
      const originalContent = candidate.content
      const originalTokens = estimator.estimateText(originalContent)
      const stored = await store.put(originalContent)
      const replacement = archivedContent(
        stored.handle,
        stored.bytes,
        originalTokens,
        preview(originalContent, previewCharacters),
      )
      candidate.message.content = replacement
      const measuredTokens = (await measure(reduced)).tokens
      if (measuredTokens >= afterTokens) {
        candidate.message.content = originalContent
        continue
      }
      const record: EvictionRecord = {
        messageIndex: candidate.messageIndex,
        handle: stored.handle,
        originalTokens,
        retainedTokens: estimator.estimateText(replacement),
        reductionClass: "SAFE",
      }
      evictions.push(record)
      archived.push({ candidate, originalContent, handle: stored.handle, bytes: stored.bytes, originalTokens, record })
      afterTokens = measuredTokens
    }

    for (const retainedCharacters of [minimumPreviewCharacters, emergencyPreviewCharacters]) {
      for (const entry of archived) {
        if (afterTokens <= targetTokens) break
        const previous = entry.candidate.message.content
        const replacement = archivedContent(
          entry.handle,
          entry.bytes,
          entry.originalTokens,
          preview(entry.originalContent, retainedCharacters),
        )
        entry.candidate.message.content = replacement
        const measuredTokens = (await measure(reduced)).tokens
        if (measuredTokens >= afterTokens) {
          entry.candidate.message.content = previous
          continue
        }
        entry.record.retainedTokens = estimator.estimateText(replacement)
        afterTokens = measuredTokens
      }
    }

    if (options.compactArchiveMetadata !== false) {
      for (const entry of archived) {
        if (afterTokens <= targetTokens) break
        const previous = entry.candidate.message.content
        const replacement = compactArchivedContent(entry.handle)
        entry.candidate.message.content = replacement
        const measuredTokens = (await measure(reduced)).tokens
        if (measuredTokens >= afterTokens) {
          entry.candidate.message.content = previous
          continue
        }
        entry.record.retainedTokens = estimator.estimateText(replacement)
        afterTokens = measuredTokens
      }
    }

    if (afterTokens > budget.safeInput) {
      const historicalArguments = reduced.messages.flatMap((message, messageIndex) => {
        if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !historicalAssistantIndexes.has(messageIndex)) return []
        return (message.tool_calls as Array<Record<string, unknown>>).flatMap((call, callIndex) => {
          const fn = call.function
          if (!fn || typeof fn !== "object" || typeof (fn as Record<string, unknown>).arguments !== "string") return []
          return [{ message, messageIndex, call, callIndex, original: (fn as Record<string, unknown>).arguments as string }]
        })
      })
      for (const entry of historicalArguments) {
        if (afterTokens <= budget.safeInput) break
        const stored = await store.put(entry.original)
        const marker = archivedArgumentContent(stored.handle)
        if (!parseValidJsonObject(marker)) continue
        const fn = entry.call.function as Record<string, unknown>
        fn.arguments = marker
        const measuredTokens = (await measure(reduced)).tokens
        if (measuredTokens >= afterTokens) {
          fn.arguments = entry.original
          continue
        }
        evictions.push({
          messageIndex: entry.messageIndex,
          handle: stored.handle,
          originalTokens: estimator.estimateText(entry.original),
          retainedTokens: estimator.estimateText(marker),
          reductionClass: "HISTORICAL_ARGUMENT",
        })
        afterTokens = measuredTokens
      }
    }

    // LIVE_EVIDENCE remains hard-overflow-only. Do not use it merely to chase
    // the governor's proactive target below safeInput.
    if (afterTokens > budget.safeInput) {
      const liveCandidates = allToolCandidates
        .filter((candidate) => liveEvidenceIndexes.has(candidate.messageIndex))
        .sort((left, right) => right.messageIndex - left.messageIndex)
      const liveSafetyMargin = Math.max(0, Math.floor(options.liveEvidenceSafetyMarginTokens ?? 64))
      const liveFitLimit = Math.max(1, budget.safeInput - liveSafetyMargin)
      for (const candidate of liveCandidates) {
        if (afterTokens <= budget.safeInput) break
        const originalContent = candidate.content
        const originalTokens = estimator.estimateText(originalContent)
        const baselineTokens = afterTokens
        const stored = await store.put(originalContent)
        const emptyMarker = liveEvidenceContentWithoutExcerpt(stored.handle, originalTokens)
        candidate.message.content = emptyMarker
        const markerTokens = (await measure(reduced)).tokens
        if (markerTokens >= baselineTokens) {
          candidate.message.content = originalContent
          continue
        }

        let bestReplacement = emptyMarker
        let bestRetainedTokens = estimator.estimateText(emptyMarker)
        let bestMeasuredTokens = markerTokens
        if (markerTokens <= liveFitLimit) {
          let low = 0
          let high = originalContent.length
          while (low <= high) {
            const retainedCharacters = Math.floor((low + high) / 2)
            const replacement = liveEvidenceContent(
              stored.handle,
              originalTokens,
              preview(originalContent, retainedCharacters),
              estimator,
            )
            candidate.message.content = replacement
            const measuredTokens = (await measure(reduced)).tokens
            if (measuredTokens < baselineTokens && measuredTokens <= liveFitLimit) {
              bestReplacement = replacement
              bestRetainedTokens = estimator.estimateText(replacement)
              bestMeasuredTokens = measuredTokens
              low = retainedCharacters + 1
            } else {
              high = retainedCharacters - 1
            }
          }
        }

        candidate.message.content = bestReplacement
        evictions.push({
          messageIndex: candidate.messageIndex,
          handle: stored.handle,
          originalTokens,
          retainedTokens: bestRetainedTokens,
          reductionClass: "LIVE_EVIDENCE",
        })
        afterTokens = bestMeasuredTokens
      }
    }
  }

  const result: ReductionResult = {
    request: reduced,
    beforeTokens,
    afterTokens,
    reclaimedTokens: beforeTokens - afterTokens,
    evictions,
    fits: afterTokens <= budget.safeInput,
  }
  if (!result.fits) throw new ContextBudgetExceededError(result, budget)
  return result
}
