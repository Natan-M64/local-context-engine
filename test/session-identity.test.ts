import assert from "node:assert/strict"
import test from "node:test"
import { resolveSessionIdentity } from "../src/context/session-identity.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

function payload(firstPrompt = "first prompt"): ChatCompletionRequest {
  return {
    model: "local-model",
    user: "shared-user",
    messages: [{ role: "user", content: firstPrompt }],
  }
}

test("keeps one conversation identity across changing request IDs", () => {
  const first = resolveSessionIdentity({
    headers: { "x-session-id": "conversation-A", "x-request-id": "request-1" },
    payload: payload(),
    remoteAddress: "127.0.0.1",
  })
  const second = resolveSessionIdentity({
    headers: { "x-session-id": "conversation-A", "x-request-id": "request-2" },
    payload: payload(),
    remoteAddress: "127.0.0.1",
  })

  assert.equal(first.source, "explicit")
  assert.equal(first.governorKey, second.governorKey)
  assert.notEqual(first.sessionKeyHash, "conversation-A")
  assert.equal(first.sessionKeyHash?.length, 64)
})

test("separates simultaneous conversations sharing IP, model, and user", () => {
  const first = resolveSessionIdentity({ headers: {}, payload: payload("conversation one"), remoteAddress: "127.0.0.1" })
  const second = resolveSessionIdentity({ headers: {}, payload: payload("conversation two"), remoteAddress: "127.0.0.1" })

  assert.equal(first.source, "inferred")
  assert.equal(second.source, "inferred")
  assert.notEqual(first.governorKey, second.governorKey)
})

test("keeps two explicit session IDs independent", () => {
  const first = resolveSessionIdentity({ headers: { "x-session-id": "session-A" }, payload: payload(), remoteAddress: "127.0.0.1" })
  const second = resolveSessionIdentity({ headers: { "x-session-id": "session-B" }, payload: payload(), remoteAddress: "127.0.0.1" })

  assert.equal(first.source, "explicit")
  assert.equal(second.source, "explicit")
  assert.notEqual(first.governorKey, second.governorKey)
})

test("classifies model, IP, and user without a conversation prefix as weak", () => {
  const identity = resolveSessionIdentity({
    headers: { "x-request-id": "request-only" },
    payload: { model: "local-model", user: "shared-user", messages: [] },
    remoteAddress: "127.0.0.1",
  })

  assert.equal(identity.source, "weak")
  assert.equal(identity.governorKey, undefined)
  assert.equal(identity.sessionKeyHash?.length, 64)
})

test("uses stateless fallback without any reliable identifier", () => {
  const identity = resolveSessionIdentity({ headers: {}, payload: { messages: [] } })

  assert.deepEqual(identity, { source: "stateless" })
})

test("uses a configured stable identity header but never x-request-id", () => {
  const configured = resolveSessionIdentity({
    headers: { "x-client-conversation": "stable-A" },
    configuredHeader: "x-client-conversation",
    payload: { messages: [] },
  })
  const requestId = resolveSessionIdentity({
    headers: { "x-request-id": "request-A" },
    configuredHeader: "x-request-id",
    payload: { messages: [] },
  })

  assert.equal(configured.source, "explicit")
  assert.equal(configured.sessionKeyHash?.length, 64)
  assert.equal(requestId.source, "stateless")
})
