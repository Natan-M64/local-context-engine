import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createContextBudget } from "../src/context/budget.js"
import { ContextBudgetExceededError, reduceRequestToBudget } from "../src/context/reduce.js"
import { FilesystemContentStore } from "../src/eviction/store.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

const budget = createContextBudget({ effectiveContext: 1_000, outputReserve: 200, safetyReserve: 100 })

async function withStore(run: (store: FilesystemContentStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  try {
    await run(new FilesystemContentStore(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("forwards requests already within budget without changing messages", async () => {
  await withStore(async (store) => {
    const request: ChatCompletionRequest = {
      model: "local-model",
      messages: [{ role: "user", content: "short request" }],
    }
    const result = await reduceRequestToBudget(request, budget, store)
    assert.equal(result.fits, true)
    assert.equal(result.evictions.length, 0)
    assert.deepEqual(result.request, request)
  })
})

test("archives old tool outputs until the request fits", async () => {
  await withStore(async (store) => {
    const oldOutput = "A".repeat(2_400)
    const currentOutput = "B".repeat(1_600)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "inspect files" },
        { role: "tool", tool_call_id: "old", content: oldOutput },
        { role: "assistant", content: "continuing" },
        { role: "tool", tool_call_id: "current", content: currentOutput },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store, { previewCharacters: 120 })
    assert.equal(result.fits, true)
    assert.ok(result.evictions.length >= 1)
    assert.equal(await store.get(result.evictions[0]!.handle), oldOutput)
    assert.match(String(result.request.messages[2]!.content), /Tool output archived/)
    assert.deepEqual(request.messages[2]!.content, oldOutput)
  })
})

test("fails closed when deterministic tool eviction cannot satisfy the budget", async () => {
  await withStore(async (store) => {
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(3_600) },
        { role: "user", content: "preserve this request" },
      ],
    }
    await assert.rejects(
      reduceRequestToBudget(request, budget, store),
      (error: unknown) => error instanceof ContextBudgetExceededError
        && error.result.fits === false
        && error.result.evictions.length === 0,
    )
  })
})
