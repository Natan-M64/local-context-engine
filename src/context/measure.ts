import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js"

export type EstimatorConfidence = "exact" | "conservative" | "approximate"

export interface TokenEstimate {
  tokens: number
  confidence: EstimatorConfidence
}

export interface TokenEstimator {
  readonly confidence: EstimatorConfidence
  estimateText(text: string): number
  estimateTextDetailed(text: string): TokenEstimate
}

export class CharacterTokenEstimator implements TokenEstimator {
  readonly confidence: EstimatorConfidence = "conservative"

  constructor(private readonly charactersPerToken = 4) {
    if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) {
      throw new RangeError("charactersPerToken must be greater than zero")
    }
  }

  estimateText(text: string): number {
    return Math.ceil(text.length / this.charactersPerToken)
  }

  estimateTextDetailed(text: string): TokenEstimate {
    return { tokens: this.estimateText(text), confidence: this.confidence }
  }
}

export function messageText(message: ChatMessage): string {
  return JSON.stringify(message)
}

export interface TokenBreakdown {
  system_messages: number
  user_messages: number
  assistant_content: number
  assistant_tool_calls: number
  assistant_tool_call_arguments: number
  current_tool_results: number
  old_tool_results: number
  tool_definitions: number
  tool_descriptions: number
  request_other: number
  unattributed_tokens: number
}

export interface ToolEvidenceClassification {
  safeMessageIndexes: number[]
  liveEvidenceMessageIndexes: number[]
}

const BREAKDOWN_KEYS = [
  "system_messages",
  "user_messages",
  "assistant_content",
  "assistant_tool_calls",
  "assistant_tool_call_arguments",
  "current_tool_results",
  "old_tool_results",
  "tool_definitions",
  "tool_descriptions",
  "request_other",
] as const

type AttributedTokenKey = (typeof BREAKDOWN_KEYS)[number]

function jsonValue(value: unknown): string {
  return JSON.stringify(value) ?? ""
}

function withoutArguments(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") return entry
    const call = structuredClone(entry) as Record<string, unknown>
    if (call.function && typeof call.function === "object") delete (call.function as Record<string, unknown>).arguments
    return call
  })
}

function collectArguments(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const fn = (entry as Record<string, unknown>).function
    if (!fn || typeof fn !== "object" || !("arguments" in fn)) return []
    return [(fn as Record<string, unknown>).arguments]
  })
}

function hasToolCalls(message: ChatMessage): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.some((call) => Boolean(call) && typeof call === "object")
}

export function classifyToolEvidence(messages: ChatMessage[]): ToolEvidenceClassification {
  const toolMessageIndexes = messages.flatMap((message, messageIndex) => message.role === "tool" ? [messageIndex] : [])
  const currentToolRoundStart = messages.findLastIndex(hasToolCalls)
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user")
  const latestToolIndex = toolMessageIndexes.at(-1) ?? -1
  const safeMessageIndexes = currentToolRoundStart >= 0
    ? toolMessageIndexes.filter((messageIndex) => messageIndex < currentToolRoundStart)
    : latestUserIndex > latestToolIndex
      ? toolMessageIndexes
      : toolMessageIndexes.slice(0, -1)
  const safe = new Set(safeMessageIndexes)
  return {
    safeMessageIndexes,
    liveEvidenceMessageIndexes: toolMessageIndexes.filter((messageIndex) => !safe.has(messageIndex)),
  }
}

function splitDescriptions(value: unknown, descriptions: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => splitDescriptions(entry, descriptions))
  if (!value || typeof value !== "object") return value
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === "description") descriptions.push(entry)
    else copy[key] = splitDescriptions(entry, descriptions)
  }
  return copy
}

export function estimateRequestTokens(
  request: ChatCompletionRequest,
  estimator: TokenEstimator = new CharacterTokenEstimator(),
): number {
  return estimator.estimateText(JSON.stringify(request))
}

export function estimateTokenBreakdown(
  request: ChatCompletionRequest,
  estimator: TokenEstimator = new CharacterTokenEstimator(),
): TokenBreakdown {
  const descriptions: unknown[] = []
  const definitions = splitDescriptions(request.tools ?? [], descriptions)
  const values: Record<AttributedTokenKey, unknown[]> = {
    system_messages: [],
    user_messages: [],
    assistant_content: [],
    assistant_tool_calls: [],
    assistant_tool_call_arguments: [],
    current_tool_results: [],
    old_tool_results: [],
    tool_definitions: request.tools === undefined || request.tools.length === 0 ? [] : [definitions],
    tool_descriptions: descriptions,
    request_other: [],
  }
  const evidence = classifyToolEvidence(request.messages)
  const liveEvidenceIndexes = new Set(evidence.liveEvidenceMessageIndexes)

  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "system" || message.role === "developer") values.system_messages.push(message)
    else if (message.role === "user") values.user_messages.push(message)
    else if (message.role === "tool") values[liveEvidenceIndexes.has(messageIndex) ? "current_tool_results" : "old_tool_results"].push(message)
    else if (message.role === "assistant") {
      if (message.content !== undefined) values.assistant_content.push(message.content)
      if (message.tool_calls !== undefined) {
        values.assistant_tool_calls.push(withoutArguments(message.tool_calls))
        values.assistant_tool_call_arguments.push(...collectArguments(message.tool_calls))
      }
    }
  }

  const other = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "messages" && key !== "tools"))
  if (Object.keys(other).length > 0) values.request_other.push(other)
  const total = estimateRequestTokens(request, estimator)
  const raw = Object.fromEntries(BREAKDOWN_KEYS.map((key) => [key, values[key].length === 0 ? 0 : estimator.estimateText(jsonValue(values[key]))])) as Record<AttributedTokenKey, number>
  const rawTotal = BREAKDOWN_KEYS.reduce((sum, key) => sum + raw[key], 0)
  const scale = rawTotal > total ? total / rawTotal : 1
  const breakdown = Object.fromEntries(BREAKDOWN_KEYS.map((key) => [key, Math.floor(raw[key] * scale)])) as Record<AttributedTokenKey, number>
  const attributed = BREAKDOWN_KEYS.reduce((sum, key) => sum + breakdown[key], 0)
  return { ...breakdown, unattributed_tokens: total - attributed }
}
