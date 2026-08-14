import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createContextBudget } from "../src/context/budget.js"
import { MultiSessionGovernor, createGovernorState, evaluateGovernor, updateGovernorAfterReduction } from "../src/context/governor.js"
import { estimateRequestTokens } from "../src/context/measure.js"
import { ContextBudgetExceededError, reduceRequestToBudget } from "../src/context/reduce.js"
import { FilesystemContentStore } from "../src/eviction/store.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

const budget = createContextBudget({ effectiveContext: 25_088, outputReserve: 4_096, safetyReserve: 6_144 })

async function withStore(run: (store: FilesystemContentStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lce-hardening-"))
  try {
    await run(new FilesystemContentStore(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("isolates governor hysteresis state between concurrent sessions", () => {
  const governor = new MultiSessionGovernor()
  const budgetLocal = createContextBudget({ effectiveContext: 10_000, outputReserve: 1_000, safetyReserve: 1_000 })
  assert.equal(governor.evaluate("session-A", 6_200, budgetLocal).shouldReduce, true)
  governor.updateAfterReduction("session-A", 6_200, 3_600)
  assert.equal(governor.evaluate("session-A", 5_800, budgetLocal).shouldReduce, false)
  assert.equal(governor.evaluate("session-B", 6_200, budgetLocal).shouldReduce, true)
})

test("simulates long session without governor thrashing", () => {
  const state = createGovernorState()
  let reductions = 0
  let currentTokens = 3_000
  for (let turn = 1; turn <= 40; turn++) {
    currentTokens += 400
    const goal = evaluateGovernor(currentTokens, budget, state)
    if (goal.shouldReduce) {
      reductions += 1
      updateGovernorAfterReduction(state, currentTokens, goal.targetTokens)
      currentTokens = goal.targetTokens
    }
  }
  assert.ok(reductions >= 2 && reductions <= 4)
})

test("target is best-effort when protected content already fits safeInput", async () => {
  await withStore(async (store) => {
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(18_000) },
        { role: "user", content: "U".repeat(10_000) },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store, { targetTokens: 6_681 })
    assert.equal(result.fits, true)
    assert.ok(result.afterTokens > 6_681)
    assert.ok(result.afterTokens <= budget.safeInput)
    assert.equal(result.evictions.length, 0)
  })
})

test("preventive reduction evicts only old tool results", async () => {
  await withStore(async (store) => {
    const userInstruction = "Use PowerShell on Windows 11. ".repeat(50)
    const assistantProgress = "Known invoice evidence. ".repeat(80)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: userInstruction },
        { role: "assistant", content: assistantProgress },
        ...Array.from({ length: 10 }, (_, index) => ({
          role: "tool" as const,
          tool_call_id: `old_${index}`,
          content: `old evidence ${index} `.repeat(220),
        })),
        { role: "user", content: "Continue." },
      ],
    }
    const localBudget = createContextBudget({ effectiveContext: 10_000, outputReserve: 1_000, safetyReserve: 1_000 })
    const result = await reduceRequestToBudget(request, localBudget, store, { targetTokens: 3_600 })
    assert.equal(result.fits, true)
    assert.ok(result.evictions.length > 0)
    assert.equal(result.request.messages[1]!.content, userInstruction)
    assert.equal(result.request.messages[2]!.content, assistantProgress)
    assert.equal(result.request.messages.at(-1)!.content, "Continue.")
  })
})

test("hard overflow fails closed when SAFE content is insufficient", async () => {
  await withStore(async (store) => {
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(5_000) },
        { role: "user", content: "U".repeat(5_000) },
      ],
    }
    const localBudget = createContextBudget({ effectiveContext: 2_000, outputReserve: 200, safetyReserve: 100 })
    await assert.rejects(reduceRequestToBudget(request, localBudget, store), ContextBudgetExceededError)
  })
})

test("reproduces 29514-token LIVE_EVIDENCE overflow and preserves protocol through CAS archival", async () => {
  await withStore(async (store) => {
    const currentEvidence = "E".repeat(15_780 * 4)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(5_361 * 4) },
        { role: "user", content: "U".repeat(345 * 4) },
        {
          role: "assistant",
          content: "A".repeat(43 * 4),
          tool_calls: [{
            id: "call_live",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "current.log", limit: 20_000 }) },
          }],
        },
        { role: "tool", name: "read", tool_call_id: "call_live", content: currentEvidence },
      ],
      tools: [{
        type: "function",
        function: {
          name: "read",
          description: "D".repeat(5_740 * 4),
          parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
        },
      }],
    }
    request.padding = ""
    const initialTokens = estimateRequestTokens(request)
    let padding = "P".repeat(Math.max(0, (29_514 - initialTokens) * 4 - 14))
    request.padding = padding
    while (estimateRequestTokens(request) < 29_514) {
      padding += "P"
      request.padding = padding
    }
    while (estimateRequestTokens(request) > 29_514) {
      padding = padding.slice(0, -1)
      request.padding = padding
    }
    const localBudget = createContextBudget({ effectiveContext: 25_088, outputReserve: 6_272, safetyReserve: 2_048 })
    const result = await reduceRequestToBudget(request, localBudget, store, { targetTokens: 7_545 })
    const liveEvictions = result.evictions.filter((eviction) => eviction.reductionClass === "LIVE_EVIDENCE")

    assert.equal(result.beforeTokens, 29_514)
    assert.equal(localBudget.safeInput, 16_768)
    assert.equal(liveEvictions.length, 1)
    assert.equal(result.fits, true)
    assert.ok(result.afterTokens <= 16_768)
    assert.equal(await store.get(liveEvictions[0]!.handle), currentEvidence)
    assert.equal(result.request.messages[3]!.role, "tool")
    assert.equal(result.request.messages[3]!.name, "read")
    assert.equal(result.request.messages[3]!.tool_call_id, "call_live")
    assert.deepEqual(result.request.messages[2]!.tool_calls, request.messages[2]!.tool_calls)
    assert.match(String(result.request.messages[3]!.content), /Current tool output partially archived/)
    assert.match(String(result.request.messages[3]!.content), /--- BEGIN EXCERPT ---[\s\S]+--- END EXCERPT ---/)
  })
})

test("tool descriptions remain protected under hard overflow", async () => {
  await withStore(async (store) => {
    const description = "Sensitive operational tool guidance ".repeat(250)
    const request: ChatCompletionRequest = {
      messages: [{ role: "user", content: "current request" }],
      tools: [{ type: "function", function: { name: "edit", description, parameters: { type: "object" } } }],
    }
    const localBudget = createContextBudget({ effectiveContext: 1_000, outputReserve: 200, safetyReserve: 100 })
    await assert.rejects(reduceRequestToBudget(request, localBudget, store), ContextBudgetExceededError)
    assert.equal((request.tools![0] as { function: { description: string } }).function.description, description)
  })
})

test("old user prompts remain protected when target cannot be reached", async () => {
  await withStore(async (store) => {
    const oldRequirement = "Keep Windows PowerShell semantics. ".repeat(100)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "user", content: oldRequirement },
        { role: "assistant", content: "progress" },
        { role: "user", content: "continue" },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store, { targetTokens: 100 })
    assert.equal(result.fits, true)
    assert.equal(result.evictions.length, 0)
    assert.equal(result.request.messages[0]!.content, oldRequirement)
  })
})

test("historical tool-call arguments archive without changing caller-owned protocol data", async () => {
  await withStore(async (store) => {
    const argumentsValue = JSON.stringify({ patch: "P".repeat(12_000) })
    const request: ChatCompletionRequest = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_old", type: "function", function: { name: "edit", arguments: argumentsValue } }] },
        { role: "tool", tool_call_id: "call_old", content: "done" },
        { role: "user", content: "continue" },
      ],
    }
    const localBudget = createContextBudget({ effectiveContext: 1_000, outputReserve: 200, safetyReserve: 100 })
    const result = await reduceRequestToBudget(request, localBudget, store)
    const eviction = result.evictions.find((entry) => entry.reductionClass === "HISTORICAL_ARGUMENT")
    assert.ok(eviction)
    const originalCall = (request.messages[0]!.tool_calls as Array<{ id: string; function: { arguments: string } }>)[0]!
    const reducedCall = (result.request.messages[0]!.tool_calls as Array<{ id: string; function: { arguments: string } }>)[0]!
    assert.equal(originalCall.id, "call_old")
    assert.equal(originalCall.function.arguments, argumentsValue)
    assert.equal(reducedCall.id, "call_old")
    assert.match(reducedCall.function.arguments, /ctx:\/\/sha256\//)
    assert.equal(result.request.messages[1]!.tool_call_id, "call_old")
    assert.equal(await store.get(eviction.handle), argumentsValue)
  })
})
