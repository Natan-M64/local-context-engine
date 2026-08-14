import type { ChatCompletionRequest } from "../../types/openai.js"

export interface TokenMeasurementProvider {
  /**
   * Estimate the token count for a complete ChatCompletionRequest.
   * Providers may return undefined if they do not support the request format
   * or if the model is not found, triggering fallback to the generic provider.
   */
  estimateChatRequest(request: ChatCompletionRequest): Promise<number | undefined>
}
