import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContextBudget } from "../src/context/budget.js"
import { estimateRequestTokens } from "../src/context/measure.js"
import { reduceRequestToBudget } from "../src/context/reduce.js"
import { FilesystemContentStore } from "../src/eviction/store.js"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ChatCompletionRequest, ChatMessage } from "../src/types/openai.js"

interface Fixture {
  runtimeContext: number
  outputReserve: number
  safetyReserve: number
  systemCharacters: number
  toolOutputs: Array<{ id: string; kind: string; characters: number }>
  recentEvidence: { toolCallId: string; content: string }
}

const fixturePath = new URL("./fixtures/session-ses_0075.sanitized.json", import.meta.url)

function toolRound(id: string, content: string): ChatMessage[] {
  return [
    { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content },
  ]
}

test("replays a sanitized Windows multi-read session within the loaded LM Studio budget", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-replay-"))
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "S".repeat(fixture.systemCharacters) },
      { role: "user", content: "Investigate invoice visibility using SQL, JSON, logs, and project code." },
    ]
    for (const output of fixture.toolOutputs) {
      messages.push(...toolRound(output.id, `${output.kind.toUpperCase()}:`.padEnd(output.characters, output.kind[0] ?? "X")))
    }
    messages.push(...toolRound(fixture.recentEvidence.toolCallId, fixture.recentEvidence.content))
    messages.push({ role: "user", content: "Continue the investigation using the evidence already found." })

    const request: ChatCompletionRequest = {
      model: "qwen_qwen3.5-9b@q6_k_l",
      messages,
      tools: [{ type: "function", function: { name: "read", description: "Read a file" } }],
    }
    const budget = createContextBudget({
      effectiveContext: fixture.runtimeContext,
      outputReserve: fixture.outputReserve,
      safetyReserve: fixture.safetyReserve,
    })
    const store = new FilesystemContentStore(root)
    const result = await reduceRequestToBudget(request, budget, store)

    assert.ok(result.beforeTokens > budget.safeInput)
    assert.ok(result.afterTokens <= budget.safeInput)
    assert.ok(result.evictions.length > 0)
    assert.equal(estimateRequestTokens(result.request), result.afterTokens)
    assert.equal(result.request.messages.at(-1)?.content, "Continue the investigation using the evidence already found.")

    const evidence = result.request.messages.find((message) => message.tool_call_id === fixture.recentEvidence.toolCallId)
    assert.equal(evidence?.content, fixture.recentEvidence.content)
    const evidenceCall = result.request.messages.find((message) =>
      Array.isArray(message.tool_calls)
      && message.tool_calls.some((call: { id?: string }) => call.id === fixture.recentEvidence.toolCallId),
    )
    assert.ok(evidenceCall)

    for (const eviction of result.evictions) {
      assert.ok(await store.get(eviction.handle))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
