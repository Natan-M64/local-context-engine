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

export function estimateRequestTokens(
  request: ChatCompletionRequest,
  estimator: TokenEstimator = new CharacterTokenEstimator(),
): number {
  return estimator.estimateText(JSON.stringify(request))
}
