import assert from "node:assert/strict"
import test from "node:test"
import { ReasoningSseStripper } from "../src/gateway/reasoning-stream.js"

const reasoningOnly = 'data: {"id":"x","model":"qwen","choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}\n\n'
const content = 'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"think","content":"answer"},"finish_reason":null}]}\n\n'
const toolStart = 'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"think","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n'
const toolEnd = 'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n'
const finish = 'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'
const usage = 'data: {"id":"x","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3},"stats":{"tps":4}}\n\n'
const done = "data: [DONE]\n\n"

function strip(input: string, cuts: number[] = []): { output: string; stripper: ReasoningSseStripper } {
  const stripper = new ReasoningSseStripper()
  let output = ""
  let offset = 0
  for (const cut of cuts) {
    output += stripper.push(Buffer.from(input.slice(offset, cut)))
    offset = cut
  }
  output += stripper.push(Buffer.from(input.slice(offset)))
  output += stripper.flush()
  return { output, stripper }
}

test("strip drops reasoning-only events and preserves protocol events", () => {
  const result = strip(reasoningOnly + content + toolStart + toolEnd + finish + usage + done)
  assert.doesNotMatch(result.output, /reasoning_content/)
  assert.match(result.output, /"model":"qwen"/)
  assert.match(result.output, /"content":"answer"/)
  assert.match(result.output, /"id":"call_1"/)
  assert.match(result.output, /"name":"read"/)
  assert.match(result.output, /"arguments":"\{\\"path\\""/)
  assert.match(result.output, /"arguments":":\\"README.md\\"\}"/)
  assert.match(result.output, /"finish_reason":"tool_calls"/)
  assert.match(result.output, /"usage":\{"prompt_tokens":10,"completion_tokens":3\}/)
  assert.match(result.output, /"stats":\{"tps":4\}/)
  assert.ok(result.output.endsWith(done))
  assert.equal(result.stripper.observation.reasoningSeen, true)
  assert.equal(result.stripper.observation.reasoningStripped, true)
  assert.equal(result.stripper.observation.reasoningChunksStripped, 3)
  assert.equal(result.stripper.observation.toolCallSeen, true)
  assert.equal(result.stripper.observation.finishReason, "tool_calls")
})

test("strip handles arbitrary SSE and UTF-8 byte fragmentation", () => {
  const input = content.replace("answer", "resposta ç") + done
  const bytes = Buffer.from(input)
  const stripper = new ReasoningSseStripper()
  let output = ""
  for (const byte of bytes) output += stripper.push(Uint8Array.of(byte))
  output += stripper.flush()
  assert.doesNotMatch(output, /reasoning_content/)
  assert.match(output, /resposta ç/)
  assert.ok(output.endsWith(done))
})

test("strip preserves malformed and non-data SSE events", () => {
  const input = "event: ping\ndata: not-json\n\n: keepalive\n\n"
  assert.equal(strip(input).output, input)
})

test("strip preserves SSE fields and envelope metadata", () => {
  const input = 'event: message\nid: event-1\nretry: 1000\n: comment\ndata: {"id":"chunk-1","object":"chat.completion.chunk","created":1,"model":"qwen","system_fingerprint":"fp","choices":[{"index":0,"delta":{"reasoning_content":"think","content":"answer"},"finish_reason":null}]}\n\n'
  const output = strip(input).output
  assert.match(output, /^event: message\nid: event-1\nretry: 1000\n: comment\n/)
  assert.match(output, /"id":"chunk-1"/)
  assert.match(output, /"object":"chat.completion.chunk"/)
  assert.match(output, /"created":1/)
  assert.match(output, /"model":"qwen"/)
  assert.match(output, /"system_fingerprint":"fp"/)
  assert.doesNotMatch(output, /reasoning_content/)
})

test("strip transforms an unterminated final event and CR-delimited events", () => {
  const unterminated = content.trimEnd()
  const crDelimited = content.replaceAll("\n", "\r") + done.replaceAll("\n", "\r")
  assert.doesNotMatch(strip(unterminated).output, /reasoning_content/)
  const output = strip(crDelimited).output
  assert.doesNotMatch(output, /reasoning_content/)
  assert.match(output, /data: \[DONE\]/)
})

test("strip handles multiple choices and tool calls without changing order", () => {
  const input = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think","tool_calls":[{"index":0,"id":"one","type":"function","function":{"name":"first","arguments":"{}"}},{"index":1,"id":"two","type":"function","function":{"name":"second","arguments":"{}"}}]}},{"index":1,"delta":{"content":"answer"}}]}\n\n'
  const output = strip(input).output
  assert.doesNotMatch(output, /reasoning_content/)
  assert.ok(output.indexOf('"id":"one"') < output.indexOf('"id":"two"'))
  assert.match(output, /"index":1,"delta":\{"content":"answer"\}/)
})
