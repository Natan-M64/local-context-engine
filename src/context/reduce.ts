import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js"
import type { ContextBudget } from "./budget.js"
import { CharacterTokenEstimator, classifyToolEvidence, estimateRequestTokens, type TokenEstimator } from "./measure.js"
import type { ContentStore } from "../eviction/store.js"

export type ReductionClass = "SAFE" | "LIVE_EVIDENCE" | "CAUTIOUS" | "PROTECTED"

export interface EvictionRecord {
  messageIndex: number
  handle: string
  originalTokens: number
  retainedTokens: number
  reductionClass: "SAFE" | "LIVE_EVIDENCE"
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

function handleOnlyArchivedContent(handle: string): string {
  return handle
}

function liveEvidenceExcerpt(
  content: string,
  handle: string,
  originalTokens: number,
  incrementalTokenBudget: number,
  estimator: TokenEstimator,
): { replacement: string; retainedTokens: number } {
  const emptyMarker = liveEvidenceContentWithoutExcerpt(handle, originalTokens)
  const emptyTokens = estimator.estimateText(emptyMarker)
  let low = 0
  let high = content.length
  let replacement = emptyMarker
  let retainedTokens = emptyTokens
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = liveEvidenceContent(handle, originalTokens, preview(content, middle), estimator)
    const candidateTokens = estimator.estimateText(candidate)
    if (candidateTokens - emptyTokens <= incrementalTokenBudget) {
      replacement = candidate
      retainedTokens = candidateTokens
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return { replacement, retainedTokens }
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
      const record: EvictionRecord = {
        messageIndex: candidate.messageIndex,
        handle: stored.handle,
        originalTokens,
        retainedTokens: estimator.estimateText(replacement),
        reductionClass: "SAFE",
      }
      evictions.push(record)
      archived.push({ candidate, originalContent, handle: stored.handle, bytes: stored.bytes, originalTokens, record })
      afterTokens = (await measure(reduced)).tokens
    }

    for (const retainedCharacters of [minimumPreviewCharacters, emergencyPreviewCharacters]) {
      for (const entry of archived) {
        if (afterTokens <= targetTokens) break
        const replacement = archivedContent(
          entry.handle,
          entry.bytes,
          entry.originalTokens,
          preview(entry.originalContent, retainedCharacters),
        )
        entry.candidate.message.content = replacement
        entry.record.retainedTokens = estimator.estimateText(replacement)
        afterTokens = (await measure(reduced)).tokens
      }
    }

    if (options.compactArchiveMetadata !== false) {
      for (const entry of archived) {
        if (afterTokens <= targetTokens) break
        const replacement = compactArchivedContent(entry.handle)
        entry.candidate.message.content = replacement
        entry.record.retainedTokens = estimator.estimateText(replacement)
        afterTokens = (await measure(reduced)).tokens
      }
    }

    if (afterTokens > budget.safeInput) {
      const liveCandidates = allToolCandidates
        .filter((candidate) => liveEvidenceIndexes.has(candidate.messageIndex))
        .sort((left, right) => right.messageIndex - left.messageIndex)
      const liveSafetyMargin = Math.max(0, Math.floor(options.liveEvidenceSafetyMarginTokens ?? 64))
      const liveEntries = [] as Array<{
        candidate: (typeof liveCandidates)[number]
        originalContent: string
        handle: string
        originalTokens: number
        markerOverhead: number
        record: EvictionRecord
      }>
      for (const candidate of liveCandidates) {
        const originalContent = candidate.content
        const originalTokens = estimator.estimateText(originalContent)
        const stored = await store.put(originalContent)
        const emptyMarker = liveEvidenceContentWithoutExcerpt(stored.handle, originalTokens)
        candidate.message.content = emptyMarker
        const record: EvictionRecord = {
          messageIndex: candidate.messageIndex,
          handle: stored.handle,
          originalTokens,
          retainedTokens: estimator.estimateText(emptyMarker),
          reductionClass: "LIVE_EVIDENCE",
        }
        evictions.push(record)
        liveEntries.push({
          candidate,
          originalContent,
          handle: stored.handle,
          originalTokens,
          markerOverhead: record.retainedTokens,
          record,
        })
      }

      afterTokens = (await measure(reduced)).tokens
      let availableLiveBudget = Math.max(0, budget.safeInput - afterTokens - liveSafetyMargin)
      for (const entry of liveEntries) {
        const excerpt = liveEvidenceExcerpt(
          entry.originalContent,
          entry.handle,
          entry.originalTokens,
          Math.min(entry.originalTokens, availableLiveBudget),
          estimator,
        )
        const incrementalTokens = Math.max(0, excerpt.retainedTokens - entry.markerOverhead)
        entry.candidate.message.content = excerpt.replacement
        entry.record.retainedTokens = excerpt.retainedTokens
        availableLiveBudget -= incrementalTokens
      }
      afterTokens = (await measure(reduced)).tokens
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
