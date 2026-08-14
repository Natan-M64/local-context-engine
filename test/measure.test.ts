import assert from "node:assert/strict"
import test from "node:test"
import { CharacterTokenEstimator, estimateRequestTokens, estimateTokenBreakdown } from "../src/context/measure.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

const keys = [
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
  "unattributed_tokens",
] as const

test("leaves absent categories at zero", () => {
  const request: ChatCompletionRequest = { messages: [{ role: "user", content: "only user" }] }
  const breakdown = estimateTokenBreakdown(request)
  assert.equal(breakdown.system_messages, 0)
  assert.equal(breakdown.assistant_content, 0)
  assert.equal(breakdown.assistant_tool_calls, 0)
  assert.equal(breakdown.assistant_tool_call_arguments, 0)
  assert.equal(breakdown.current_tool_results, 0)
  assert.equal(breakdown.old_tool_results, 0)
  assert.equal(breakdown.tool_definitions, 0)
  assert.equal(breakdown.tool_descriptions, 0)
  assert.equal(breakdown.request_other, 0)
})

test("attributes request tokens by metadata-only category", () => {
  const secret = "SENSITIVE_VALUE_NEVER_LOG"
  const request: ChatCompletionRequest = {
    model: "local",
    temperature: 0,
    messages: [
      { role: "system", content: `system ${secret}` },
      { role: "user", content: `user ${secret}` },
      {
        role: "assistant",
        content: `assistant ${secret}`,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: secret }) } }],
      },
      { role: "tool", tool_call_id: "call_1", content: `result ${secret}` },
    ],
    tools: [{
      type: "function",
      function: {
        name: "read",
        description: `description ${secret}`,
        parameters: { type: "object", properties: { path: { type: "string", description: `path ${secret}` } } },
      },
    }],
  }
  const estimator = new CharacterTokenEstimator()
  const breakdown = estimateTokenBreakdown(request, estimator)
  const sum = keys.reduce((total, key) => total + breakdown[key], 0)

  assert.equal(sum, estimateRequestTokens(request, estimator))
  for (const key of keys) assert.ok(breakdown[key] >= 0)
  assert.ok(breakdown.system_messages > 0)
  assert.ok(breakdown.user_messages > 0)
  assert.ok(breakdown.assistant_content > 0)
  assert.ok(breakdown.assistant_tool_calls > 0)
  assert.ok(breakdown.assistant_tool_call_arguments > 0)
  assert.ok(breakdown.current_tool_results > 0)
  assert.equal(breakdown.old_tool_results, 0)
  assert.ok(breakdown.tool_definitions > 0)
  assert.ok(breakdown.tool_descriptions > 0)
  assert.ok(breakdown.request_other > 0)
  assert.equal(JSON.stringify(breakdown).includes(secret), false)
})
