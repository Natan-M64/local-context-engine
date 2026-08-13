import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { createGatewayServer, type RequestMetrics } from "../src/gateway/server.js"
import { CharacterTokenEstimator, estimateRequestTokens } from "../src/context/measure.js"
import type { EngineConfig } from "../src/config.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing server address")
  return address.port
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, "close")
}

test("passes models through and reduces oversized chat requests before forwarding", async () => {
  let receivedChat: unknown
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "local", loaded_instances: [{ config: { context_length: 1_000 } }] }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    receivedChat = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
    response.end("data: [DONE]\n\n")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const config: EngineConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 1_000,
    outputReserve: 200,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  }
  const gateway = createGatewayServer(config)
  const gatewayPort = await listen(gateway)

  try {
    const models = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)
    assert.equal(models.status, 200)
    assert.equal((await models.json() as { data: unknown[] }).data.length, 1)

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local",
        stream: true,
        messages: [
          { role: "user", content: "inspect" },
          { role: "assistant", tool_calls: [{ id: "one", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "one", content: "X".repeat(3_200) },
        ],
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "data: first\n\ndata: [DONE]\n\n")
    const request = receivedChat as { messages: Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }> }
    assert.match(request.messages[2]!.content!, /Tool output archived/)
    assert.equal(request.messages[2]!.tool_call_id, "one")
    assert.equal(request.messages[1]!.tool_calls?.[0]?.id, request.messages[2]!.tool_call_id)
    assert.ok(estimateRequestTokens(receivedChat as ChatCompletionRequest) <= 700)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("reduces the golden multi-read request below the safe input budget", async () => {
  let received: ChatCompletionRequest | undefined
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "local", loaded_instances: [{ config: { context_length: 25_088 } }] }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest
    response.end("ok")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    outputReserve: 4_096,
    safetyReserve: 2_000,
    storeRoot: root,
    maxRequestBytes: 4_000_000,
  })
  const gatewayPort = await listen(gateway)
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local",
        messages: [
          { role: "system", content: "S".repeat(10_000) },
          { role: "user", content: "U".repeat(4_000) },
          { role: "assistant", tool_calls: [{ id: "sql", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "sql", content: "SQL".repeat(4_700) },
          { role: "tool", tool_call_id: "users", content: "USERS".repeat(2_400) },
          { role: "tool", tool_call_id: "groups", content: "GROUPS".repeat(2_000) },
          { role: "tool", tool_call_id: "tracker", content: "LOG".repeat(1_400) },
        ],
        tools: [{ type: "function", function: { name: "read", description: "R".repeat(2_000) } }],
      }),
    })
    assert.equal(response.status, 200)
    assert.ok(received)
    assert.ok(estimateRequestTokens(received!, new CharacterTokenEstimator()) <= 18_992)
    const messages = received!.messages
    const assistant = messages.find((message) => message.role === "assistant") as { tool_calls?: Array<{ id: string }> } | undefined
    const tool = messages.find((message) => message.tool_call_id === "sql")
    assert.equal(assistant?.tool_calls?.[0]?.id, tool?.tool_call_id)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("preserves a below-budget non-streaming response and records metrics", async () => {
  let receivedBody = ""
  const metrics: RequestMetrics[] = []
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    receivedBody = Buffer.concat(chunks).toString("utf8")
    response.writeHead(200, { "content-type": "application/json", "x-upstream": "kept" })
    response.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion" }))
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 10_000,
    outputReserve: 500,
    safetyReserve: 500,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  }, (entry) => metrics.push(entry))
  const gatewayPort = await listen(gateway)
  const payload = { model: "local", messages: [{ role: "user", content: "small" }] }
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client": "preserve" },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { id: "chatcmpl-test", object: "chat.completion" })
    assert.equal(response.headers.get("x-upstream"), "kept")
    assert.equal(receivedBody, JSON.stringify(payload))
    assert.equal(metrics[0]?.forwardingDecision, "forwarded")
    assert.equal(metrics[0]?.numberOfEvictions, 0)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("aborts an upstream stream when the client cancels", async () => {
  let upstreamAborted = false
  const upstream = http.createServer((request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\\n\\n")
    response.on("close", () => {
      upstreamAborted = true
      response.destroy()
    })
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 10_000,
    outputReserve: 500,
    safetyReserve: 500,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  })
  const gatewayPort = await listen(gateway)
  try {
    const client = http.request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    client.end(JSON.stringify({ messages: [{ role: "user", content: "stream" }] }))
    await once(client, "response")
    client.destroy()
    for (let attempt = 0; attempt < 10 && !upstreamAborted; attempt += 1) await delay(10)
    assert.equal(upstreamAborted, true)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("returns a structured budget error when reserves consume the loaded context", async () => {
  let chatCalls = 0
  const metrics: RequestMetrics[] = []
  const upstream = http.createServer((request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "local", loaded_instances: [{ config: { context_length: 4_096 } }] }] }))
      return
    }
    if (request.url?.includes("chat/completions")) chatCalls += 1
    response.end("unexpected")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    outputReserve: 4_096,
    safetyReserve: 2_048,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  }, (entry) => metrics.push(entry))
  const gatewayPort = await listen(gateway)
  const payload: ChatCompletionRequest = { model: "local", messages: [{ role: "user", content: "request" }] }
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: {
        type: "context_budget_exceeded",
        message: "Output and safety reserves leave no safe input budget.",
        effective_context: 4_096,
        output_reserve: 4_096,
        safety_reserve: 2_048,
        safe_input: 0,
        request_tokens: estimateRequestTokens(payload),
      },
    })
    assert.equal(chatCalls, 0)
    assert.equal(metrics[0]?.forwardingDecision, "context_budget_exceeded")
    assert.equal(metrics[0]?.safeInput, 0)
    assert.equal(metrics[0]?.estimatorConfidence, "conservative")
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("fails closed when runtime discovery and explicit context are unavailable", async () => {
  let chatCalls = 0
  const upstream = http.createServer((request, response) => {
    if (request.url?.includes("chat/completions")) chatCalls += 1
    response.end("unexpected")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    outputReserve: 200,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  })
  const gatewayPort = await listen(gateway)
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "request" }] }),
    })
    assert.equal(response.status, 503)
    assert.equal((await response.json() as { error: { type: string } }).error.type, "context_window_unknown")
    assert.equal(chatCalls, 0)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("fails closed without calling upstream when preserved context cannot fit", async () => {
  let chatCalls = 0
  const upstream = http.createServer((request, response) => {
    if (request.url?.includes("chat/completions")) chatCalls += 1
    response.end("unexpected")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 1_000,
    outputReserve: 200,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  })
  const gatewayPort = await listen(gateway)

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: "S".repeat(4_000) }] }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json() as { error: { type: string } }).error.type, "context_budget_exceeded")
    assert.equal(chatCalls, 0)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})
