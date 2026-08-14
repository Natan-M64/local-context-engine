import type { ChatCompletionRequest } from "../../types/openai.js"

export interface TokenMeasurement {
  tokens: number
  source: string
  confidence: "exact" | "approximate"
}

export interface TokenMeasurementProvider {
  /**
   * Estimate the token count for a complete ChatCompletionRequest.
   * Returns a TokenMeasurement if successful, or undefined if the provider cannot handle the request.
   */
  estimateChatRequest(request: ChatCompletionRequest): Promise<TokenMeasurement | undefined>
}
