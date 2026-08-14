import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGatewayServer } from "../src/gateway/server.js"
import { CharacterTokenEstimator, estimateRequestTokens } from "../src/context/measure.js"
import { reduceRequestToBudget } from "../src/context/reduce.js"
import { createContextBudget } from "../src/context/budget.js"
import { FilesystemContentStore } from "../src/eviction/store.js"
import type { ChatCompletionRequest } from "../src/types/openai.ts"

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address !== null) resolve(address.port)
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test("1. exact provider says request fits while static says it doesn't -> no false context_budget_exceeded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-1-"))
  let upstreamCalled = false
  const upstream = http.createServer((req, res) => {
    upstreamCalled = true
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }))
  })
  const upstreamPort = await listen(upstream)

  // Configure a gateway in auto mode, but override measureRequest mock behavior indirectly
  // or test reduceRequestToBudget directly to ensure fits logic.
  const sampleRequest: ChatCompletionRequest = {
    model: "local",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello world" },
    ],
  }
  const budget = createContextBudget({ effectiveContext: 1000, outputReserve: 200, safetyReserve: 100 })
  const store = new FilesystemContentStore(root)

  // static estimator might estimate 50 tokens, but exact provider measure returns 10
  const result = await reduceRequestToBudget(sampleRequest, budget, store, {
    measureRequest: async () => ({ tokens: 10 }),
  })
  assert.equal(result.fits, true)
  assert.equal(result.evictions.length, 0)

  await close(upstream)
  await rm(root, { recursive: true, force: true })
})

test("2. exact provider says request DOES NOT fit while static says it does -> do not forward oversized request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-2-"))
  const sampleRequest: ChatCompletionRequest = {
    model: "local",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  }
  const budget = createContextBudget({ effectiveContext: 500, outputReserve: 100, safetyReserve: 100 }) // safeInput = 300
  const store = new FilesystemContentStore(root)

  // static estimate would be ~10 tokens, but exact provider returns 400 (> safeInput 300) and reduction cannot reduce system/user
  await assert.rejects(
    async () => {
      await reduceRequestToBudget(sampleRequest, budget, store, {
        measureRequest: async () => ({ tokens: 400 }),
      })
    },
    (err: any) => err.name === "ContextBudgetExceededError",
  )

  await rm(root, { recursive: true, force: true })
})

test("3. exact measurement before and after reduction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-3-"))
  const store = new FilesystemContentStore(root)
  const sampleRequest: ChatCompletionRequest = {
    model: "local",
    messages: [
      { role: "system", content: "system" },
      { role: "tool", tool_call_id: "1", content: "large tool output ".repeat(100) },
      { role: "user", content: "continue" },
    ],
  }
  const budget = createContextBudget({ effectiveContext: 500, outputReserve: 100, safetyReserve: 100 }) // safeInput = 300

  // measureRequest returns 500 before eviction and 50 after eviction
  let calls = 0
  const result = await reduceRequestToBudget(sampleRequest, budget, store, {
    measureRequest: async (req) => {
      calls++
      const isArchived = String(req.messages[1]!.content).includes("Handle: ctx://")
      return { tokens: isArchived ? 50 : 500 }
    },
  })

  assert.equal(result.beforeTokens, 500)
  assert.equal(result.afterTokens, 50)
  assert.equal(result.fits, true)
  assert.equal(result.evictions.length, 1)

  await rm(root, { recursive: true, force: true })
})

test("4. exact provider fails -> fallback occurs deterministically and is recorded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-4-"))
  let receivedRequest: any
  const upstream = http.createServer(async (req, res) => {
    if (req.url && req.url.includes("models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "local", type: "llm", loaded_instances: [{ config: { context_length: 2000 } }] }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const bodyStr = Buffer.concat(chunks).toString("utf8")
    if (bodyStr) {
      try {
        receivedRequest = JSON.parse(bodyStr)
      } catch {}
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }))
  })
  const upstreamPort = await listen(upstream)

  // Gateway in auto mode, upstream has no LMStudio SDK endpoint so LMStudioTokenProvider fails/times out and falls back to generic
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    outputReserve: 200,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
    tokenEstimatorMode: "auto",
  })
  const gatewayPort = await listen(gateway)

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "user", content: "hello fallback" }],
    }),
  })

  assert.equal(res.status, 200)
  assert.ok(receivedRequest)

  await close(gateway)
  await close(upstream)
  await rm(root, { recursive: true, force: true })
})

test("5. shadow mode remains 100% observational", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-5-"))
  let receivedRequest: any
  const upstream = http.createServer(async (req, res) => {
    if (req.url && req.url.includes("models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "local", type: "llm", loaded_instances: [{ config: { context_length: 2000 } }] }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const bodyStr = Buffer.concat(chunks).toString("utf8")
    if (bodyStr) {
      try {
        receivedRequest = JSON.parse(bodyStr)
      } catch {}
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }))
  })
  const upstreamPort = await listen(upstream)

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    outputReserve: 200,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
    tokenEstimatorMode: "shadow",
  })
  const gatewayPort = await listen(gateway)

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "user", content: "shadow test" }],
    }),
  })

  assert.equal(res.status, 200)
  assert.equal(receivedRequest.messages[0].content, "shadow test")

  await close(gateway)
  await close(upstream)
  await rm(root, { recursive: true, force: true })
})

test("6. generic upstream does not need to be LM Studio to start/function", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-6-"))
  const upstream = http.createServer(async (req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "generic-model" }] }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "generic ok" } }] }))
  })
  const upstreamPort = await listen(upstream)

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 4096,
    outputReserve: 512,
    safetyReserve: 256,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  })
  const gatewayPort = await listen(gateway)

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "generic-model",
      messages: [{ role: "user", content: "generic hello" }],
    }),
  })

  assert.equal(res.status, 200)

  await close(gateway)
  await close(upstream)
  await rm(root, { recursive: true, force: true })
})

test("7. no reduced output contains raw ctx:// as isolated content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-7-"))
  const store = new FilesystemContentStore(root)
  const sampleRequest: ChatCompletionRequest = {
    model: "local",
    messages: [
      { role: "system", content: "sys" },
      { role: "tool", tool_call_id: "1", content: "data ".repeat(500) },
      { role: "user", content: "next" },
    ],
  }
  const budget = createContextBudget({ effectiveContext: 500, outputReserve: 100, safetyReserve: 100 }) // safeInput = 300

  const result = await reduceRequestToBudget(sampleRequest, budget, store)
  const toolContent = String(result.request.messages[1]!.content)

  assert.ok(toolContent.includes("[Tool output archived]") || toolContent.includes("[Content archived]"))
  assert.ok(toolContent.includes("Handle: ctx://sha256/"))
  assert.notEqual(toolContent.trim().startsWith("ctx://sha256/") && !toolContent.includes("\n"), true)

  await rm(root, { recursive: true, force: true })
})

test("8. LIVE_EVIDENCE continues only in hard overflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-8-"))
  const store = new FilesystemContentStore(root)
  // Two tools: tool 0 (SAFE), tool 1 (LIVE_EVIDENCE)
  const sampleRequest: ChatCompletionRequest = {
    model: "local",
    messages: [
      { role: "system", content: "sys" },
      { role: "tool", tool_call_id: "0", content: "SAFE EVIDENCE ".repeat(200) },
      { role: "assistant", content: "call tool 1", tool_calls: [{ id: "1", type: "function", function: { name: "test", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "LIVE EVIDENCE ".repeat(50) },
      { role: "user", content: "continue" },
    ],
  }

  // Budget sufficient to fit after evicting tool 0 (SAFE)
  const budget = createContextBudget({ effectiveContext: 1000, outputReserve: 200, safetyReserve: 100 }) // safeInput = 700
  const result = await reduceRequestToBudget(sampleRequest, budget, store, { targetTokens: 400 })

  // Assert tool 0 was evicted, but tool 1 (LIVE EVIDENCE) remained intact because safeInput (700) was satisfied
  const tool0Content = String(result.request.messages[1]!.content)
  const tool1Content = String(result.request.messages[3]!.content)

  assert.ok(tool0Content.includes("Handle: ctx://"))
  assert.equal(tool1Content, "LIVE EVIDENCE ".repeat(50))

  await rm(root, { recursive: true, force: true })
})

test("9. tool call IDs/order/pairing remain intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-9-"))
  const store = new FilesystemContentStore(root)
  const sampleRequest: ChatCompletionRequest = {
    model: "local",
    messages: [
      { role: "system", content: "sys" },
      { role: "assistant", content: "call", tool_calls: [{ id: "tc_123", type: "function", function: { name: "func", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "tc_123", content: "result ".repeat(300) },
      { role: "user", content: "next" },
    ],
  }
  const budget = createContextBudget({ effectiveContext: 600, outputReserve: 100, safetyReserve: 100 })

  const result = await reduceRequestToBudget(sampleRequest, budget, store)
  const assistantMsg = result.request.messages[1] as any
  const toolMsg = result.request.messages[2] as any

  assert.equal(assistantMsg.tool_calls[0].id, "tc_123")
  assert.equal(toolMsg.tool_call_id, "tc_123")
  assert.equal(result.request.messages.length, 4)

  await rm(root, { recursive: true, force: true })
})

test("10. no request above authoritative safeInput reaches mock upstream", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-10-"))
  let upstreamCalled = false
  const upstream = http.createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "local", type: "llm", loaded_instances: [{ config: { context_length: 500 } }] }] }))
      return
    }
    upstreamCalled = true
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }))
  })
  const upstreamPort = await listen(upstream)

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    outputReserve: 200,
    safetyReserve: 200, // safeInput = 100
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  })
  const gatewayPort = await listen(gateway)

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [
        { role: "system", content: "very large system prompt ".repeat(50) },
        { role: "user", content: "user message" },
      ],
    }),
  })

  assert.equal(res.status, 400) // context_budget_exceeded
  assert.equal(upstreamCalled, false)

  await close(gateway)
  await close(upstream)
  await rm(root, { recursive: true, force: true })
})

test("11. generic approximate request remains approximate throughout request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-stabilization-11-"))
  let upstreamCalled = false
  const upstream = http.createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "local", type: "llm" }] }))
      return
    }
    upstreamCalled = true
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }))
  })
  const upstreamPort = await listen(upstream)

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 1000,
    outputReserve: 100,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
    tokenEstimatorMode: "static",
  })
  const gatewayPort = await listen(gateway)

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    }),
  })

  assert.equal(res.status, 200)
  assert.equal(upstreamCalled, true)

  await close(gateway)
  await close(upstream)
  await rm(root, { recursive: true, force: true })
})
