import { LMStudioClient } from "@lmstudio/sdk"
import type { ChatCompletionRequest, ChatMessage } from "../../types/openai.js"

export interface RuntimeEstimatorMetrics {
  static_tokens: number
  runtime_tokens: number
  estimator_delta: number
  estimator_ratio: number
  runtime_estimator_latency_ms: number
}

// Map the generic openai request into the strict types from @lmstudio/sdk
export function mapMessages(messages: ChatMessage[]): any[] {
  return messages.map(m => {
    if (m.role === "system") return { role: "system", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }
    if (m.role === "user") return { role: "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }
    if (m.role === "tool") {
      return { 
        role: "tool", 
        content: [
          {
            type: "toolCallResult",
            toolCallId: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
          }
        ]
      }
    }
    if (m.role === "assistant") {
      const parts: any[] = []
      if (m.content) {
        parts.push({ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })
      }
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          if (!call || typeof call !== "object") continue
          const toolCall = call as any
          parts.push({
            type: "toolCallRequest",
            toolCallRequest: {
              name: toolCall.function?.name ?? "",
              arguments: typeof toolCall.function?.arguments === "string" ? JSON.parse(toolCall.function.arguments) : toolCall.function?.arguments
            }
          })
        }
      }
      return { role: "assistant", content: parts }
    }
    // Fallback unmapped roles to user
    return { role: "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }
  })
}

export function mapTools(tools: unknown[]): any[] {
  if (!Array.isArray(tools)) return []
  return tools.map((t: any) => {
    return {
      type: "function",
      function: {
        name: t?.function?.name ?? "",
        description: t?.function?.description,
        parameters: t?.function?.parameters
      }
    }
  })
}

export class LMStudioRuntimeEstimator {
  private client: LMStudioClient
  
  constructor(baseUrl: string) {
    const base = new URL(baseUrl)
    this.client = new LMStudioClient({ baseUrl: `ws://${base.host}` })
  }

  async estimateChatRequest(request: ChatCompletionRequest): Promise<number> {
    const model = await this.client.llm.model(request.model ?? "")
    const messages = mapMessages(request.messages)
    const formatted = await model.applyPromptTemplate(messages, {
      toolDefinitions: mapTools(request.tools ?? [])
    })
    const tokens = await model.countTokens(formatted)
    return tokens
  }
}
