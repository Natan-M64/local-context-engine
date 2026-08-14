import test from "node:test"
import assert from "node:assert/strict"
import { LMStudioRuntimeEstimator, mapMessages, mapTools } from "../src/context/runtime-estimator/lmstudio.js"

test("LMStudioRuntimeEstimator maps request correctly", async () => {
  const tools = [{ type: "function", function: { name: "get_weather", description: "Get the weather", parameters: { type: "object", properties: { location: { type: "string" } } } } }]
  const mappedTools = mapTools(tools)
  assert.equal(mappedTools[0]?.type, "function")
  assert.equal(mappedTools[0]?.function.name, "get_weather")
  assert.deepEqual(mappedTools[0]?.function.parameters, tools[0]?.function.parameters)

  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What's the weather in Tokyo?" },
    { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Tokyo\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"temp\":22}" }
  ]
  const mappedMessages = mapMessages(messages)
  
  assert.equal(mappedMessages[0]?.role, "system")
  assert.equal(mappedMessages[1]?.role, "user")
  assert.equal(mappedMessages[2]?.role, "assistant")
  assert.equal(mappedMessages[2]?.content[0].type, "toolCallRequest")
  assert.deepEqual(mappedMessages[2]?.content[0].toolCallRequest.arguments, { location: "Tokyo" })
  assert.equal(mappedMessages[3]?.role, "tool")
  assert.equal(mappedMessages[3]?.content[0].type, "toolCallResult")
  assert.equal(mappedMessages[3]?.content[0].toolCallId, "call_1")
})
