import { createHmac, randomBytes } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"
import type { ChatCompletionRequest } from "../types/openai.js"

export type SessionIdentitySource = "explicit" | "inferred" | "weak" | "stateless"

export interface SessionIdentity {
  governorKey?: string
  sessionKeyHash?: string
  source: SessionIdentitySource
}

export interface SessionIdentityInput {
  headers: IncomingHttpHeaders
  payload: ChatCompletionRequest
  remoteAddress?: string
  configuredHeader?: string
}

const identityHashKey = randomBytes(32)

function hashIdentity(namespace: string, value: unknown): string {
  return createHmac("sha256", identityHashKey).update(namespace).update("\0").update(JSON.stringify(value)).digest("hex")
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  const first = Array.isArray(value) ? value[0] : value
  const normalized = first?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function explicitIdentity(headers: IncomingHttpHeaders, configuredHeader?: string): string | undefined {
  for (const header of ["x-session-id", "x-conversation-id"]) {
    const value = headerValue(headers, header)
    if (value !== undefined) return hashIdentity(`header:${header}`, value)
  }
  if (configuredHeader !== undefined) {
    const header = configuredHeader.trim().toLowerCase()
    if (header.length > 0 && header !== "x-request-id") {
      const value = headerValue(headers, header)
      if (value !== undefined) return hashIdentity(`header:${header}`, value)
    }
  }
  return undefined
}

function inferredIdentity(payload: ChatCompletionRequest, remoteAddress?: string): string | undefined {
  const firstUserIndex = payload.messages.findIndex((message) => message.role === "user" && message.content !== undefined)
  if (firstUserIndex < 0) return undefined
  return hashIdentity("conversation-prefix", {
    remoteAddress: remoteAddress ?? null,
    model: payload.model ?? null,
    user: typeof payload.user === "string" ? payload.user : null,
    prefix: payload.messages.slice(0, firstUserIndex + 1),
  })
}

function weakIdentity(payload: ChatCompletionRequest, remoteAddress?: string): string | undefined {
  const user = typeof payload.user === "string" && payload.user.length > 0 ? payload.user : undefined
  if (payload.model === undefined && user === undefined && remoteAddress === undefined) return undefined
  return hashIdentity("weak-client", {
    remoteAddress: remoteAddress ?? null,
    model: payload.model ?? null,
    user: user ?? null,
  })
}

export function resolveSessionIdentity(input: SessionIdentityInput): SessionIdentity {
  const explicit = explicitIdentity(input.headers, input.configuredHeader)
  if (explicit !== undefined) return { governorKey: explicit, sessionKeyHash: explicit, source: "explicit" }

  const inferred = inferredIdentity(input.payload, input.remoteAddress)
  if (inferred !== undefined) return { governorKey: inferred, sessionKeyHash: inferred, source: "inferred" }

  const weak = weakIdentity(input.payload, input.remoteAddress)
  if (weak !== undefined) return { sessionKeyHash: weak, source: "weak" }

  return { source: "stateless" }
}
