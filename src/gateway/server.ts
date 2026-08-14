import http, { type IncomingHttpHeaders, type Server } from "node:http"
import { createContextBudget } from "../context/budget.js"
import { CharacterTokenEstimator, estimateRequestTokens, type EstimatorConfidence } from "../context/measure.js"
import { ContextBudgetExceededError, reduceRequestToBudget } from "../context/reduce.js"
import { FilesystemContentStore } from "../eviction/store.js"
import { discoverRuntimeContext } from "../runtime/discovery.js"
import type { ChatCompletionRequest } from "../types/openai.js"
import type { EngineConfig } from "../config.js"

export interface RequestMetrics {
  requestTokensBefore?: number
  requestTokensAfter?: number
  safeInput?: number
  reclaimedTokens?: number
  numberOfEvictions?: number
  physicalContext?: number
  effectiveContext?: number
  contextSource?: "loaded" | "configured"
  outputReserve?: number
  safetyReserve?: number
  estimatorConfidence?: EstimatorConfidence
  streamCompleted?: boolean
  streamDoneMarkerSeen?: boolean
  streamFinishReasonSeen?: boolean
  clientAborted?: boolean
  forwardingDecision: "forwarded" | "context_budget_exceeded" | "context_unknown" | "invalid_request" | "upstream_error"
}

function upstreamUrl(baseUrl: string, requestUrl = "/"): URL {
  const base = new URL(baseUrl)
  const incoming = new URL(requestUrl, "http://localhost")
  base.pathname = incoming.pathname
  base.search = incoming.search
  return base
}

function forwardedHeaders(headers: IncomingHttpHeaders): HeadersInit {
  const forwarded: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || ["host", "content-length", "connection", "accept-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(key.toLowerCase())) continue
    forwarded[key] = Array.isArray(value) ? value.join(", ") : value
  }
  return forwarded
}

async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new RangeError(`request exceeds ${maxBytes} byte limit`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function json(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

function responseHeaders(upstream: Response): Record<string, string> {
  const headers = Object.fromEntries(upstream.headers.entries())
  delete headers["content-length"]
  delete headers["content-encoding"]
  return headers
}

function configuredSafetyReserve(contextWindow: number, configured?: number): number {
  return configured ?? Math.max(2_048, Math.ceil(contextWindow * 0.08))
}

function outputReserve(payload: ChatCompletionRequest, configured: number): number {
  const requested = Number(payload.max_completion_tokens ?? payload.max_tokens)
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : configured
}

function isChatCompletion(request: http.IncomingMessage): boolean {
  return request.method === "POST" && /\/v1\/chat\/completions(?:\?|$)/.test(request.url ?? "")
}

function observeStreamChunk(metrics: RequestMetrics, previous: string, chunk: Uint8Array): string {
  const text = previous + Buffer.from(chunk).toString("utf8")
  if (text.includes("data: [DONE]")) metrics.streamDoneMarkerSeen = true
  if (/"finish_reason"\s*:\s*"[^"]+"/.test(text)) metrics.streamFinishReasonSeen = true
  return text.slice(-128)
}

export function createGatewayServer(
  config: EngineConfig,
  metricsSink: (metrics: RequestMetrics) => void = () => undefined,
): Server {
  const store = new FilesystemContentStore(config.storeRoot)
  return http.createServer(async (request, response) => {
    const controller = new AbortController()
    const chatCompletion = isChatCompletion(request)
    const metrics: RequestMetrics = { forwardingDecision: "upstream_error" }
    request.on("aborted", () => {
      metrics.clientAborted = true
      controller.abort()
    })
    response.on("close", () => {
      if (!response.writableEnded) {
        metrics.clientAborted = true
        controller.abort()
      }
    })

    try {
      if (request.url === "/health") {
        json(response, 200, { status: "ok", upstream: config.upstreamBaseUrl })
        return
      }

      const incomingBody = await readBody(request, config.maxRequestBytes)
      let outgoingBody: Buffer | undefined = incomingBody
      if (incomingBody?.length && chatCompletion) {
        const payload = JSON.parse(incomingBody.toString("utf8")) as ChatCompletionRequest
        if (!Array.isArray(payload.messages)) {
          metrics.forwardingDecision = "invalid_request"
          json(response, 400, { error: { type: "invalid_request", message: "messages must be an array" } })
          return
        }
        const estimator = new CharacterTokenEstimator()
        metrics.estimatorConfidence = estimator.confidence
        metrics.requestTokensBefore = estimateRequestTokens(payload, estimator)
        const discovered = await discoverRuntimeContext(config.upstreamBaseUrl, payload.model)
        const effectiveContext = discovered?.effectiveContext ?? config.contextWindow
        const contextSource = discovered ? "loaded" : config.contextWindow === undefined ? undefined : "configured"
        if (effectiveContext === undefined || contextSource === undefined) {
          metrics.forwardingDecision = "context_unknown"
          json(response, 503, {
            error: {
              type: "context_window_unknown",
              message: "Set CONTEXT_WINDOW_TOKENS or use a runtime that reports its loaded context window.",
            },
          })
          return
        }
        const requestedOutputReserve = outputReserve(payload, config.outputReserve)
        const requestedSafetyReserve = configuredSafetyReserve(effectiveContext, config.safetyReserve)
        metrics.physicalContext = effectiveContext
        metrics.effectiveContext = effectiveContext
        metrics.contextSource = contextSource
        metrics.outputReserve = requestedOutputReserve
        metrics.safetyReserve = requestedSafetyReserve
        const safeInput = effectiveContext - requestedOutputReserve - requestedSafetyReserve
        if (safeInput <= 0) {
          metrics.safeInput = 0
          metrics.forwardingDecision = "context_budget_exceeded"
          json(response, 400, {
            error: {
              type: "context_budget_exceeded",
              message: "Output and safety reserves leave no safe input budget.",
              effective_context: effectiveContext,
              output_reserve: requestedOutputReserve,
              safety_reserve: requestedSafetyReserve,
              safe_input: 0,
              request_tokens: metrics.requestTokensBefore,
            },
          })
          return
        }
        const budget = createContextBudget({
          effectiveContext,
          outputReserve: requestedOutputReserve,
          safetyReserve: requestedSafetyReserve,
        })
        metrics.safeInput = budget.safeInput
        const reduced = await reduceRequestToBudget(payload, budget, store, { estimator })
        outgoingBody = reduced.evictions.length === 0
          ? incomingBody
          : Buffer.from(JSON.stringify(reduced.request))
        metrics.requestTokensBefore = reduced.beforeTokens
        metrics.requestTokensAfter = reduced.afterTokens
        metrics.reclaimedTokens = reduced.reclaimedTokens
        metrics.numberOfEvictions = reduced.evictions.length
        metrics.forwardingDecision = "forwarded"
        response.setHeader("x-context-engine-input-tokens", String(reduced.afterTokens))
        response.setHeader("x-context-engine-reclaimed-tokens", String(reduced.reclaimedTokens))
        response.setHeader("x-context-engine-evictions", String(reduced.evictions.length))
      }

      const method = request.method ?? "GET"
      const requestInit: RequestInit = {
        method,
        headers: forwardedHeaders(request.headers),
        signal: controller.signal,
      }
      if (outgoingBody !== undefined && method !== "GET" && method !== "HEAD") {
        requestInit.body = new Uint8Array(outgoingBody)
      }
      const upstream = await fetch(upstreamUrl(config.upstreamBaseUrl, request.url), requestInit)
      response.writeHead(upstream.status, responseHeaders(upstream))
      if (!upstream.body || method === "HEAD") {
        response.end()
        return
      }
      const reader = upstream.body.getReader()
      const streaming = upstream.headers.get("content-type")?.includes("text/event-stream") ?? false
      let streamObservation = ""
      if (streaming) {
        metrics.streamCompleted = false
        metrics.streamDoneMarkerSeen = false
        metrics.streamFinishReasonSeen = false
      }
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (streaming) streamObservation = observeStreamChunk(metrics, streamObservation, chunk.value)
          if (!response.write(Buffer.from(chunk.value))) {
            await new Promise<void>((resolve) => response.once("drain", resolve))
          }
        }
        if (streaming) metrics.streamCompleted = true
      } finally {
        reader.releaseLock()
      }
      response.end()
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof ContextBudgetExceededError) {
        metrics.requestTokensBefore = error.result.beforeTokens
        metrics.requestTokensAfter = error.result.afterTokens
        metrics.reclaimedTokens = error.result.reclaimedTokens
        metrics.numberOfEvictions = error.result.evictions.length
        metrics.physicalContext = error.budget.effectiveContext
        metrics.effectiveContext = error.budget.effectiveContext
        metrics.outputReserve = error.budget.outputReserve
        metrics.safetyReserve = error.budget.safetyReserve
        metrics.safeInput = error.budget.safeInput
        metrics.forwardingDecision = "context_budget_exceeded"
        json(response, 400, {
          error: {
            type: "context_budget_exceeded",
            physical_context: error.budget.effectiveContext,
            effective_context: error.budget.effectiveContext,
            safe_input: error.budget.safeInput,
            request_tokens: error.result.afterTokens,
            reclaimed_tokens: error.result.reclaimedTokens,
          },
        })
        return
      }
      const status = error instanceof SyntaxError || error instanceof RangeError ? 400 : 502
      metrics.forwardingDecision = status === 400 ? "invalid_request" : "upstream_error"
      json(response, status, {
        error: {
          type: status === 400 ? "invalid_request" : "context_engine_error",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      if (chatCompletion) {
        try {
          metricsSink(metrics)
        } catch (error) {
          process.stderr.write(`local-context-engine metrics sink failed: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
    }
  })
}
