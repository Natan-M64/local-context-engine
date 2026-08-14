import {
  LMStudioClient,
  type ChatMessageData,
  type ChatMessagePartTextData,
  type LLMTool,
} from "@lmstudio/sdk"
import type { ChatCompletionRequest, ChatMessage } from "../../types/openai.js"
import type { TokenMeasurementProvider } from "./provider.js"

export interface RuntimeEstimatorMetrics {
  static_tokens: number
  runtime_tokens: number
  estimator_delta: number
  estimator_ratio: number
  runtime_estimator_latency_ms: number
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object")
  return value as Record<string, unknown>
}

function textParts(value: unknown): ChatMessagePartTextData[] {
  if (value === undefined || value === null) return []
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) throw new TypeError("unsupported message content")
  return value.map((part) => {
    const object = record(part)
    if (object.type !== "text" || typeof object.text !== "string") throw new TypeError("unsupported message content part")
    return { type: "text", text: object.text }
  })
}

function toolArguments(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  return record(parsed)
}

export function mapMessages(messages: ChatMessage[]): ChatMessageData[] {
  return messages.map((message): ChatMessageData => {
    if (message.role === "system" || message.role === "developer") {
      return { role: "system", content: textParts(message.content) }
    }
    if (message.role === "user") {
      return { role: "user", content: textParts(message.content) }
    }
    if (message.role === "tool") {
      const content = typeof message.content === "string" ? message.content : String(message.content ?? "")
      return {
        role: "tool",
        content: [
          {
            type: "toolCallResult",
            ...(typeof message.tool_call_id === "string" ? { toolCallId: message.tool_call_id } : {}),
            content,
          },
        ],
      }
    }
    if (message.role === "assistant") {
      const content: ChatMessageData & { role: "assistant" } = { role: "assistant", content: textParts(message.content) }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      for (const rawCall of toolCalls) {
        const call = record(rawCall)
        const functionData = record(call.function)
        if (typeof functionData.name !== "string") throw new TypeError("tool call name is required")
        content.content.push({
          type: "toolCallRequest",
          toolCallRequest: {
            type: "function",
            ...(typeof call.id === "string" ? { id: call.id } : {}),
            name: functionData.name,
            arguments: toolArguments(functionData.arguments),
          },
        })
      }
      return content
    }
    throw new TypeError(`unsupported message role: ${message.role}`)
  })
}

export function mapTools(tools: unknown[] | undefined): LLMTool[] {
  if (tools === undefined) return []
  if (!Array.isArray(tools)) throw new TypeError("tools must be an array")
  return tools.map((rawTool): LLMTool => {
    const tool = record(rawTool)
    if (tool.type !== "function") throw new TypeError("only function tools are supported")
    const functionData = record(tool.function)
    if (typeof functionData.name !== "string") throw new TypeError("tool name is required")
    const parameters = functionData.parameters
    return {
      type: "function",
      function: {
        name: functionData.name,
        ...(typeof functionData.description === "string" ? { description: functionData.description } : {}),
        ...(parameters === undefined ? {} : { parameters: parameters as LLMTool["function"]["parameters"] }),
      } as LLMTool["function"],
    }
  })
}

export interface LMStudioTokenProviderOptions {
  baseUrl: string
  verbose?: boolean
}

export class LMStudioTokenProvider implements TokenMeasurementProvider {
  private readonly client: LMStudioClient

  constructor(options: LMStudioTokenProviderOptions) {
    const base = new URL(options.baseUrl)
    this.client = new LMStudioClient({ baseUrl: `ws://${base.host}` })
  }

  async estimateChatRequest(request: ChatCompletionRequest): Promise<number | undefined> {
    try {
      const model = await this.client.llm.model(request.model ?? "", { verbose: false })
      const messages = { messages: mapMessages(request.messages) }
      const formatted = await model.applyPromptTemplate(messages, { toolDefinitions: mapTools(request.tools) })
      return model.countTokens(formatted)
    } catch {
      return undefined
    }
  }
}
