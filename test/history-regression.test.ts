import assert from "node:assert/strict"
import test from "node:test"
import { createContextBudget } from "../src/context/budget.js"
import { ContextBudgetExceededError, reduceRequestToBudget } from "../src/context/reduce.js"
import { FilesystemContentStore } from "../src/eviction/store.js"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ChatCompletionRequest } from "../src/types/openai.js"

const budget = createContextBudget({ effectiveContext: 25_088, outputReserve: 4_096, safetyReserve: 6_144 })

test("fails closed for oversized protected conversation history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-history-"))
  try {
    const messages: ChatCompletionRequest["messages"] = [{ role: "system", content: "system" }]
    for (let index = 0; index < 15; index++) {
      messages.push({ role: "user", content: `Requirement ${index}: ${"preserve ".repeat(20)}` })
      messages.push({ role: "assistant", content: `Progress ${index}: ${"known evidence ".repeat(250)}` })
    }
    const request: ChatCompletionRequest = { messages }
    const store = new FilesystemContentStore(root)
    await assert.rejects(reduceRequestToBudget(request, budget, store), ContextBudgetExceededError)
    assert.equal(request.messages[0]?.content, "system")
    assert.match(String(request.messages.at(-1)?.content), /^Progress 14:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
