import assert from "node:assert/strict"
import test from "node:test"
import { type ChatMessageData, type LLMTool } from "@lmstudio/sdk"
import type { ChatMessage } from "../src/types/openai.js"
import { mapMessages, mapTools } from "../src/context/providers/lmstudio.js"

test("maps valid openai tool definitions to sdk strict types", () => {
  const tools: unknown[] = [
    {
      type: "function",
      function: {
        name: "test",
        description: "description",
        parameters: { type: "object", properties: { p: { type: "string" } } },
      },
    },
  ]
  const mapped = mapTools(tools)
  assert.equal(mapped.length, 1)
  assert.deepEqual(mapped[0], {
    type: "function",
    function: {
      name: "test",
      description: "description",
      parameters: { type: "object", properties: { p: { type: "string" } } },
    },
  } as LLMTool)
})

test("maps valid openai messages including tool rounds to sdk strict types", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "use" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "t1", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "res" },
  ]
  const mapped = mapMessages(messages)
  assert.equal(mapped.length, 4)
  assert.deepEqual(mapped, [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "user", content: [{ type: "text", text: "use" }] },
    {
      role: "assistant",
      content: [
        { type: "toolCallRequest", toolCallRequest: { type: "function", id: "c1", name: "t1", arguments: {} } },
      ],
    },
    { role: "tool", content: [{ type: "toolCallResult", toolCallId: "c1", content: "res" }] },
  ] as ChatMessageData[])
})

test("throws on unmappable unsupported formats to ensure fallback safety", () => {
  assert.throws(() => mapTools([{ type: "unknown" }]))
  assert.throws(() => mapMessages([{ role: "unknown" }]))
  assert.throws(() => mapMessages([{ role: "user", content: [{ type: "image_url" }] }]))
  assert.throws(() => mapMessages([{ role: "assistant", tool_calls: [{ function: { arguments: "invalid json" } }] }]))
})
