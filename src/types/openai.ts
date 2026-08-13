export interface ChatMessage {
  role: string
  content?: unknown
  tool_call_id?: string
  [key: string]: unknown
}

export interface ChatCompletionRequest {
  model?: string
  messages: ChatMessage[]
  tools?: unknown[]
  max_tokens?: number
  max_completion_tokens?: number
  [key: string]: unknown
}
