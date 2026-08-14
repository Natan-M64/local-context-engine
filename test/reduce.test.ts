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

test("shrinks archived previews when the first eviction pass narrowly misses the budget", async () => {
  await withStore(async (store) => {
    const oldOutput = "EVIDENCE ".repeat(300)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(1_300) },
        { role: "user", content: "preserve this request" },
        { role: "tool", tool_call_id: "old", content: oldOutput },
        { role: "user", content: "continue" },
      ],
    }
    await assert.rejects(
      reduceRequestToBudget(request, budget, store, {
        previewCharacters: 1_200,
        minimumPreviewCharacters: 1_200,
        emergencyPreviewCharacters: 1_200,
        compactArchiveMetadata: false,
      }),
      ContextBudgetExceededError,
    )
    const result = await reduceRequestToBudget(request, budget, store, {
      previewCharacters: 1_200,
      minimumPreviewCharacters: 160,
    })
    assert.equal(result.fits, true)
    assert.equal(result.evictions.length, 1)
    assert.ok(result.evictions[0]!.retainedTokens < 200)
    const archived = String(result.request.messages[2]!.content)
    assert.match(archived, /Handle: ctx:\/\/sha256\//)
    assert.match(archived, /Preview:\nEVIDENCE/)
    assert.equal(archived.match(/\[Tool output archived\]/g)?.length, 1)
    assert.equal(await store.get(result.evictions[0]!.handle), oldOutput)
    assert.deepEqual(request.messages[2]!.content, oldOutput)
  })
})

test("removes archived previews when minimum previews still exceed the budget", async () => {
  await withStore(async (store) => {
    const outputs = Array.from({ length: 8 }, (_, index) => `EVIDENCE ${index} `.repeat(250))
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "preserve this request" },
        ...outputs.map((content, index) => ({ role: "tool" as const, tool_call_id: String(index), content })),
        { role: "user", content: "continue" },
      ],
    }
    await assert.rejects(
      reduceRequestToBudget(request, budget, store, {
        minimumPreviewCharacters: 160,
        emergencyPreviewCharacters: 160,
        compactArchiveMetadata: false,
      }),
      ContextBudgetExceededError,
    )
    const result = await reduceRequestToBudget(request, budget, store)
    assert.equal(result.fits, true)
    assert.equal(result.evictions.length, outputs.length)
    const archivedMessages = result.evictions.map((eviction, index) => {
      const archived = String(result.request.messages[index + 2]!.content)
      assert.match(archived, /Handle: ctx:\/\/sha256\//)
      assert.equal(archived.match(/\[Tool output archived\]/g)?.length, 1)
      return archived
    })
    assert.ok(archivedMessages.some((archived) => /Preview:\n$/.test(archived)))
    for (const [index, eviction] of result.evictions.entries()) {
      assert.equal(await store.get(eviction.handle), outputs[index])
    }
  })
})

test("compacts archive metadata when empty previews narrowly miss the budget", async () => {
  await withStore(async (store) => {
    const oldOutput = "EVIDENCE ".repeat(300)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(2_500) },
        { role: "user", content: "preserve this request" },
        { role: "tool", tool_call_id: "old", content: oldOutput },
        { role: "user", content: "continue" },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store)
    assert.equal(result.fits, true)
    assert.equal(result.evictions.length, 1)
    assert.equal(result.request.messages[2]!.content, `[Content archived]\nHandle: ${result.evictions[0]!.handle}`)
    assert.equal(await store.get(result.evictions[0]!.handle), oldOutput)
    assert.deepEqual(request.messages[2]!.content, oldOutput)
  })
})

test("compacts archive metadata when empty previews narrowly miss the budget", async () => {
  await withStore(async (store) => {
    const outputs = Array.from({ length: 20 }, (_, index) => `EVIDENCE ${index} `.repeat(250))
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(56_600) },
        { role: "user", content: "preserve this request" },
        ...outputs.map((content, index) => ({ role: "tool" as const, tool_call_id: String(index), content })),
        { role: "user", content: "continue" },
      ],
    }
    const result = await reduceRequestToBudget(request, createContextBudget({ effectiveContext: 25_088, outputReserve: 4_096, safetyReserve: 6_000 }), store)
    assert.equal(result.fits, true)
    assert.equal(result.evictions.length, outputs.length)
  })
})

test("archives LIVE_EVIDENCE only under hard overflow with a dynamic bounded excerpt", async () => {
  await withStore(async (store) => {
    const currentOutput = `${"HEAD_EVIDENCE ".repeat(1_200)}${"TAIL_EVIDENCE ".repeat(1_200)}`
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(2_000) },
        { role: "user", content: "inspect the current evidence" },
        {
          role: "assistant",
          content: "reading",
          tool_calls: [{ id: "call_current", type: "function", function: { name: "read", arguments: "{\"path\":\"evidence.log\"}" } }],
        },
        { role: "tool", name: "read", tool_call_id: "call_current", content: currentOutput },
      ],
    }
    const liveBudget = createContextBudget({ effectiveContext: 3_000, outputReserve: 400, safetyReserve: 200 })
    const result = await reduceRequestToBudget(request, liveBudget, store, { targetTokens: 100 })
    const eviction = result.evictions.find((entry) => entry.reductionClass === "LIVE_EVIDENCE")
    assert.ok(eviction)
    assert.equal(result.fits, true)
    assert.ok(result.afterTokens <= liveBudget.safeInput)
    assert.equal(await store.get(eviction.handle), currentOutput)
    assert.deepEqual(result.request.messages[2]!.tool_calls, request.messages[2]!.tool_calls)
    assert.equal(result.request.messages[3]!.role, "tool")
    assert.equal(result.request.messages[3]!.name, "read")
    assert.equal(result.request.messages[3]!.tool_call_id, "call_current")
    const archived = String(result.request.messages[3]!.content)
    assert.match(archived, /^\[Current tool output partially archived\]/)
    assert.match(archived, /Handle: ctx:\/\/sha256\/[a-f0-9]{64}/)
    assert.match(archived, /Original estimated tokens: \d+/)
    assert.match(archived, /Preserved estimated tokens: \d+/)
    assert.match(archived, /--- BEGIN EXCERPT ---[\s\S]*HEAD_EVIDENCE/)
    assert.match(archived, /TAIL_EVIDENCE[\s\S]*--- END EXCERPT ---/)
    assert.notEqual(archived, eviction.handle)
    assert.equal(request.messages[3]!.content, currentOutput)
  })
})

test("LIVE_EVIDENCE excerpt fitting uses authoritative whole-request measurement", async () => {
  await withStore(async (store) => {
    const currentOutput = `${"HEAD ".repeat(500)}${"TAIL ".repeat(500)}`
    const request: ChatCompletionRequest = {
      model: "local-model",
      messages: [
        { role: "system", content: "S".repeat(120) },
        { role: "user", content: "inspect current evidence" },
        {
          role: "assistant",
          content: "reading",
          tool_calls: [{ id: "call_current", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", name: "read", tool_call_id: "call_current", content: currentOutput },
      ],
    }
    const liveBudget = createContextBudget({ effectiveContext: 1_000, outputReserve: 200, safetyReserve: 100 })

    // Deliberately model a runtime where tool-message content consumes about
    // twice as many tokens as CharacterTokenEstimator predicts. This reproduces
    // the class of failure seen with exact LM Studio measurement: converting an
    // exact remaining budget into heuristic excerpt tokens can preserve too
    // much LIVE_EVIDENCE and miss final Verify.
    const measureRequest = async (candidate: ChatCompletionRequest): Promise<{ tokens: number }> => {
      let tokens = 0
      for (const message of candidate.messages) {
        if (message.role === "tool" && typeof message.content === "string") {
          tokens += Math.ceil(message.content.length / 2)
        } else {
          tokens += Math.ceil(JSON.stringify(message).length / 4)
        }
      }
      if (candidate.tools !== undefined) tokens += Math.ceil(JSON.stringify(candidate.tools).length / 4)
      return { tokens }
    }

    const initial = await measureRequest(request)
    assert.ok(initial.tokens > liveBudget.safeInput)

    const result = await reduceRequestToBudget(request, liveBudget, store, {
      measureRequest,
      targetTokens: 100,
      liveEvidenceSafetyMarginTokens: 64,
    })

    assert.equal(result.fits, true)
    assert.ok(result.afterTokens <= liveBudget.safeInput)
    assert.equal(result.afterTokens, (await measureRequest(result.request)).tokens)

    const eviction = result.evictions.find((entry) => entry.reductionClass === "LIVE_EVIDENCE")
    assert.ok(eviction)
    assert.equal(await store.get(eviction.handle), currentOutput)

    const archived = String(result.request.messages[3]!.content)
    assert.match(archived, /^\[Current tool output partially archived\]/)
    assert.match(archived, /Handle: ctx:\/\/sha256\/[a-f0-9]{64}/)
    assert.notEqual(archived, eviction.handle)
    assert.deepEqual(result.request.messages[2]!.tool_calls, request.messages[2]!.tool_calls)
    assert.equal(result.request.messages[3]!.tool_call_id, "call_current")
  })
})

test("does not archive LIVE_EVIDENCE to chase targetTokens below safeInput", async () => {
  await withStore(async (store) => {
    const currentOutput = "CURRENT ".repeat(150)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", tool_calls: [{ id: "call_current", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_current", content: currentOutput },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store, { targetTokens: 10 })
    assert.equal(result.fits, true)
    assert.ok(result.afterTokens > 10)
    assert.equal(result.evictions.length, 0)
    assert.deepEqual(result.request, request)
  })
})

test("rejects non-beneficial LIVE_EVIDENCE archival using whole-request measurement", async () => {
  await withStore(async (store) => {
    const currentOutput = "tiny"
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "S".repeat(2_900) },
        { role: "assistant", tool_calls: [{ id: "current", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "current", content: currentOutput },
      ],
    }
    const measureRequest = async (candidate: ChatCompletionRequest): Promise<{ tokens: number }> => {
      const content = String(candidate.messages[2]!.content)
      return { tokens: content === currentOutput ? 710 : 790 }
    }
    await assert.rejects(
      reduceRequestToBudget(request, budget, store, { measureRequest }),
      (error: unknown) => error instanceof ContextBudgetExceededError
        && error.result.afterTokens === 710
        && error.result.evictions.length === 0
        && error.result.request.messages[2]!.content === currentOutput,
    )
  })
})

test("archives only historical tool arguments under hard overflow", async () => {
  await withStore(async (store) => {
    const historicalArguments = JSON.stringify({ patch: "P".repeat(4_000) })
    const currentArguments = JSON.stringify({ path: "current.txt", content: "C".repeat(500) })
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", tool_calls: [{ id: "old", type: "function", function: { name: "edit", arguments: historicalArguments } }] },
        { role: "tool", tool_call_id: "old", content: "old result" },
        { role: "assistant", tool_calls: [{ id: "current", type: "function", function: { name: "write", arguments: currentArguments } }] },
        { role: "tool", tool_call_id: "current", content: "current result" },
      ],
      tools: [{ type: "function", function: { name: "edit", description: "protected", parameters: { type: "object" } } }],
    }
    const result = await reduceRequestToBudget(request, budget, store)
    const eviction = result.evictions.find((entry) => entry.reductionClass === "HISTORICAL_ARGUMENT")
    assert.ok(eviction)
    const oldCall = (result.request.messages[1]!.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>)[0]!
    const currentCall = (result.request.messages[3]!.tool_calls as Array<{ id: string; function: { arguments: string } }>)[0]!
    assert.equal(oldCall.id, "old")
    assert.equal(oldCall.type, "function")
    assert.equal(oldCall.function.name, "edit")
    assert.doesNotThrow(() => JSON.parse(oldCall.function.arguments))
    assert.match(oldCall.function.arguments, /ctx:\/\/sha256\//)
    assert.equal(await store.get(eviction.handle), historicalArguments)
    assert.equal(result.request.messages[2]!.tool_call_id, "old")
    assert.equal(currentCall.function.arguments, currentArguments)
    assert.equal(result.request.messages[4]!.tool_call_id, "current")
    assert.deepEqual(result.request.tools, request.tools)
    assert.equal(request.messages[1]!.tool_calls, request.messages[1]!.tool_calls)
  })
})

test("archives a completed last tool round after a newer user request", async () => {
  await withStore(async (store) => {
    const argumentsValue = JSON.stringify({ patch: "P".repeat(4_000) })
    const request: ChatCompletionRequest = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "done", type: "function", function: { name: "edit", arguments: argumentsValue } }] },
        { role: "tool", tool_call_id: "done", content: "done" },
        { role: "user", content: "continue" },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store)
    const eviction = result.evictions.find((entry) => entry.reductionClass === "HISTORICAL_ARGUMENT")
    assert.ok(eviction)
    assert.equal(await store.get(eviction.handle), argumentsValue)
  })
})

test("preserves unmatched and current parallel tool-call arguments", async () => {
  await withStore(async (store) => {
    const unmatched = JSON.stringify({ patch: "U".repeat(4_000) })
    const matched = JSON.stringify({ patch: "M".repeat(4_000) })
    const request: ChatCompletionRequest = {
      messages: [
        { role: "assistant", tool_calls: [
          { id: "matched", type: "function", function: { name: "edit", arguments: matched } },
          { id: "pending", type: "function", function: { name: "edit", arguments: unmatched } },
        ] },
        { role: "tool", tool_call_id: "matched", content: "done" },
        { role: "user", content: "continue" },
      ],
    }
    const constrained = createContextBudget({ effectiveContext: 1_000, outputReserve: 200, safetyReserve: 100 })
    await assert.rejects(
      reduceRequestToBudget(request, constrained, store),
      (error: unknown) => error instanceof ContextBudgetExceededError
        && (error.result.request.messages[0]!.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments === matched
        && (error.result.request.messages[0]!.tool_calls as Array<{ function: { arguments: string } }>)[1]!.function.arguments === unmatched
        && error.result.evictions.every((entry) => entry.reductionClass !== "HISTORICAL_ARGUMENT"),
    )
  })
})

test("does not archive historical arguments to chase a governor target below safeInput", async () => {
  await withStore(async (store) => {
    const argumentsValue = JSON.stringify({ patch: "P".repeat(1_500) })
    const request: ChatCompletionRequest = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "old", type: "function", function: { name: "edit", arguments: argumentsValue } }] },
        { role: "tool", tool_call_id: "old", content: "done" },
        { role: "user", content: "continue" },
      ],
    }
    const result = await reduceRequestToBudget(request, budget, store, { targetTokens: 10 })
    assert.ok(result.afterTokens > 10)
    assert.equal(result.evictions.some((entry) => entry.reductionClass === "HISTORICAL_ARGUMENT"), false)
    const call = (result.request.messages[0]!.tool_calls as Array<{ function: { arguments: string } }>)[0]!
    assert.equal(call.function.arguments, argumentsValue)
  })
})

test("never accepts a LIVE_EVIDENCE candidate that increases authoritative tokens", async () => {
  await withStore(async (store) => {
    const original = "L".repeat(2_000)
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "protected" },
        { role: "assistant", tool_calls: [{ id: "current", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "current", content: original },
      ],
    }
    const measureRequest = async (candidate: ChatCompletionRequest): Promise<{ tokens: number }> => {
      const value = String(candidate.messages[2]!.content)
      if (value === original) return { tokens: 900 }
      if (value.includes("Preserved estimated tokens: 0")) return { tokens: 650 }
      return { tokens: 950 }
    }
    const result = await reduceRequestToBudget(request, budget, store, { measureRequest, liveEvidenceSafetyMarginTokens: 0 })
    assert.equal(result.beforeTokens, 900)
    assert.equal(result.afterTokens, 650)
    assert.match(String(result.request.messages[2]!.content), /Preserved estimated tokens: 0/)
    assert.equal(result.evictions.length, 1)
    assert.equal(result.evictions[0]?.reductionClass, "LIVE_EVIDENCE")
  })
})

test("fails closed deterministically for the 325203-token hard-overflow class", async () => {
  await withStore(async (store) => {
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "protected" },
        { role: "assistant", tool_calls: [{ id: "old", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "old", content: "old".repeat(100_000) },
        { role: "assistant", tool_calls: [{ id: "current", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "current", content: "tiny" },
      ],
    }
    const measureRequest = async (candidate: ChatCompletionRequest): Promise<{ tokens: number }> => {
      const oldArchived = String(candidate.messages[2]!.content).includes("ctx://")
      const liveOriginal = candidate.messages[4]!.content === "tiny"
      if (!oldArchived) return { tokens: 325_203 }
      return { tokens: liveOriginal ? 19_216 : 19_272 }
    }
    const hardBudget = createContextBudget({ effectiveContext: 25_088, outputReserve: 4_096, safetyReserve: 2_048 })
    await assert.rejects(
      reduceRequestToBudget(request, hardBudget, store, { measureRequest, targetTokens: 8_524 }),
      (error: unknown) => error instanceof ContextBudgetExceededError
        && error.budget.safeInput === 18_944
        && error.result.beforeTokens === 325_203
        && error.result.afterTokens === 19_216
        && error.result.evictions.length === 1
        && error.result.evictions[0]?.reductionClass === "SAFE"
        && error.result.request.messages[4]!.content === "tiny",
    )
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
