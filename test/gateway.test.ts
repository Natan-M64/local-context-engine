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
          { role: "assistant", tool_calls: [{ id: "two", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "two", content: "current" },
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

test("preserves streamed tool calls and records completion evidence", async () => {
  const metrics: RequestMetrics[] = []
  const events = [
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"Vou analisar..."},"finish_reason":null}]}\n\n',
    'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    for await (const _chunk of request) {
      void _chunk
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const event of events) response.write(event)
    response.end()
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
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local", stream: true, messages: [{ role: "user", content: "inspect" }] }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    assert.equal(await response.text(), events.join(""))
    assert.equal(metrics[0]?.streamCompleted, true)
    assert.equal(metrics[0]?.streamDoneMarkerSeen, true)
    assert.equal(metrics[0]?.streamFinishReasonSeen, true)
    assert.equal(metrics[0]?.clientAborted, undefined)
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

test("uses the governor target to create headroom for continued agent steps", async () => {
  let received: ChatCompletionRequest | undefined
  const metrics: RequestMetrics[] = []
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "local", loaded_instances: [{ config: { context_length: 10_000 } }] }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "continue" }, finish_reason: "stop" }] }))
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-target-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 10_000,
    outputReserve: 1_000,
    safetyReserve: 1_000,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
  }, (entry) => metrics.push(entry))
  const gatewayPort = await listen(gateway)
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "long-agent-session" },
      body: JSON.stringify({
        model: "local",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "continue the investigation" },
          ...Array.from({ length: 10 }, (_, index) => ({
            role: "tool",
            tool_call_id: `call_${index}`,
            content: `evidence ${index} `.repeat(220),
          })),
          { role: "tool", tool_call_id: "recent", content: "recent protected evidence" },
        ],
      }),
    })

    assert.equal(response.status, 200)
    assert.ok(received)
    assert.equal(metrics[0]?.governorTriggered, true)
    assert.equal(metrics[0]?.governorTargetTokens, 3_600)
    assert.ok((metrics[0]?.numberOfEvictions ?? 0) > 0)
    assert.ok(estimateRequestTokens(received!) <= 3_600)
    assert.ok((metrics[0]?.requestTokensAfter ?? Infinity) <= 3_600)
    assert.deepEqual(received!.messages.filter((message) => message.role !== "tool"), [
      { role: "system", content: "system" },
      { role: "user", content: "continue the investigation" },
    ])
    assert.equal(received!.messages.at(-1)?.content, "recent protected evidence")
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

test("recovers an overflow by shrinking archived previews as far as needed", async () => {
  let chatCalls = 0
  let received: ChatCompletionRequest | undefined
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "local", type: "llm", loaded_instances: [{ config: { context_length: 1_000 } }] }] }))
      return
    }
    chatCalls += 1
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }))
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
      body: JSON.stringify({
        model: "local",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "preserve this request" },
          ...Array.from({ length: 8 }, (_, index) => ({
            role: "tool",
            tool_call_id: String(index),
            content: `EVIDENCE ${index} `.repeat(250),
          })),
          { role: "user", content: "continue" },
        ],
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(chatCalls, 1)
    assert.ok(received)
    assert.ok(estimateRequestTokens(received!) <= 700)
    const archived = received!.messages.filter((message) => message.role === "tool").map((message) => String(message.content))
    assert.ok(archived.every((content) => content.includes("ctx://sha256/")))
    assert.equal(received!.messages.at(-1)?.content, "continue")
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("protect mode forwards below safeInput without pruning and records requested output reserve", async () => {
  let receivedBody = ""
  const metrics: RequestMetrics[] = []
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    receivedBody = Buffer.concat(chunks).toString("utf8")
    response.end("ok")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-protect-pass-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 25_088,
    outputReserve: 4_096,
    safetyReserve: 2_048,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
    governorMode: "protect",
  }, (entry) => metrics.push(entry))
  const gatewayPort = await listen(gateway)
  const payload: ChatCompletionRequest = {
    max_completion_tokens: 8_192,
    messages: [{ role: "user", content: "small protected request" }],
  }
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 200)
    assert.equal(receivedBody, JSON.stringify(payload))
    assert.equal(metrics[0]?.governorMode, "protect")
    assert.equal(metrics[0]?.governorTriggered, false)
    assert.equal(metrics[0]?.numberOfEvictions, 0)
    assert.equal(metrics[0]?.physical_context, 25_088)
    assert.equal(metrics[0]?.effective_context, 25_088)
    assert.equal(metrics[0]?.requestedOutputTokens, 8_192)
    assert.equal(metrics[0]?.requested_output_tokens, 8_192)
    assert.equal(metrics[0]?.outputReserveEffective, 8_192)
    assert.equal(metrics[0]?.output_reserve_effective, 8_192)
    assert.equal(metrics[0]?.safety_reserve, 2_048)
    assert.equal(metrics[0]?.safeInput, 14_848)
    assert.equal(metrics[0]?.safe_input, 14_848)
    assert.deepEqual(metrics[0]?.token_breakdown_before, metrics[0]?.token_breakdown_after)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("protect mode above safeInput evicts only SAFE old tool results", async () => {
  let received: ChatCompletionRequest | undefined
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest
    response.end("ok")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-protect-evict-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 2_000,
    outputReserve: 200,
    safetyReserve: 100,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
    governorMode: "protect",
  })
  const gatewayPort = await listen(gateway)
  const description = "protected tool guidance"
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "requirement" },
          { role: "tool", tool_call_id: "old", content: "X".repeat(8_000) },
          { role: "user", content: "continue" },
        ],
        tools: [{ type: "function", function: { name: "read", description } }],
      }),
    })
    assert.equal(response.status, 200)
    assert.ok(received)
    assert.match(String(received!.messages[1]!.content), /ctx:\/\/sha256\//)
    assert.equal((received!.tools![0] as { function: { description: string } }).function.description, description)
  } finally {
    await close(gateway)
    await close(upstream)
    await rm(root, { recursive: true, force: true })
  }
})

test("records metadata-only LIVE_EVIDENCE reduction metrics", async () => {
  let received: ChatCompletionRequest | undefined
  const metrics: RequestMetrics[] = []
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/api/v1/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest
    response.end("ok")
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-live-metrics-"))
  const upstreamPort = await listen(upstream)
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    contextWindow: 3_000,
    outputReserve: 400,
    safetyReserve: 200,
    storeRoot: root,
    maxRequestBytes: 1_000_000,
    governorMode: "protect",
  }, (entry) => metrics.push(entry))
  const gatewayPort = await listen(gateway)
  const currentOutput = "LIVE_EVIDENCE ".repeat(1_000)
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "inspect" },
          { role: "assistant", tool_calls: [{ id: "call_live", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", name: "read", tool_call_id: "call_live", content: currentOutput },
        ],
      }),
    })
    assert.equal(response.status, 200)
    assert.ok(received)
    assert.match(String(received!.messages[3]!.content), /Current tool output partially archived/)
    assert.ok((metrics[0]?.live_evidence_tokens_before ?? 0) > (metrics[0]?.live_evidence_tokens_after ?? Infinity))
    assert.equal(metrics[0]?.live_evidence_evictions, 1)
    assert.ok((metrics[0]?.live_evidence_archived_tokens ?? 0) > 0)
    assert.equal(JSON.stringify(metrics[0]).includes(currentOutput), false)
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
