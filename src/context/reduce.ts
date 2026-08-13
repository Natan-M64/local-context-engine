import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js"
import type { ContextBudget } from "./budget.js"
import { CharacterTokenEstimator, estimateRequestTokens, type TokenEstimator } from "./measure.js"
import type { ContentStore } from "../eviction/store.js"

export interface EvictionRecord {
  messageIndex: number
  handle: string
  originalTokens: number
  retainedTokens: number
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

export async function reduceRequestToBudget(
  request: ChatCompletionRequest,
  budget: ContextBudget,
  store: ContentStore,
  options: { estimator?: TokenEstimator; previewCharacters?: number } = {},
): Promise<ReductionResult> {
  const estimator = options.estimator ?? new CharacterTokenEstimator()
  const previewCharacters = options.previewCharacters ?? 1_200
  const reduced: ChatCompletionRequest = {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
  }
  const beforeTokens = estimateRequestTokens(reduced, estimator)
  let afterTokens = beforeTokens
  const evictions: EvictionRecord[] = []

  if (afterTokens > budget.safeInput) {
    const candidates = reduced.messages
      .map((message, messageIndex) => ({ message, messageIndex, content: contentString(message) }))
      .filter((candidate): candidate is { message: ChatMessage; messageIndex: number; content: string } =>
        candidate.message.role === "tool" && candidate.content !== undefined,
      )
      .sort((left, right) => {
        const age = left.messageIndex - right.messageIndex
        if (age !== 0) return age
        return right.content.length - left.content.length
      })

    for (const candidate of candidates) {
      if (afterTokens <= budget.safeInput) break
      const originalTokens = estimator.estimateText(candidate.content)
      const stored = await store.put(candidate.content)
      const replacement = archivedContent(
        stored.handle,
        stored.bytes,
        originalTokens,
        preview(candidate.content, previewCharacters),
      )
      candidate.message.content = replacement
      const retainedTokens = estimator.estimateText(replacement)
      evictions.push({
        messageIndex: candidate.messageIndex,
        handle: stored.handle,
        originalTokens,
        retainedTokens,
      })
      afterTokens = estimateRequestTokens(reduced, estimator)
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
