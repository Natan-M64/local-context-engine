import http, { type IncomingHttpHeaders, type Server } from "node:http"
import { createContextBudget } from "../context/budget.js"
import { CharacterTokenEstimator, estimateRequestTokens, estimateTokenBreakdown, type EstimatorConfidence, type TokenBreakdown } from "../context/measure.js"
import { ContextBudgetExceededError, reduceRequestToBudget } from "../context/reduce.js"
import { MultiSessionGovernor, type ReductionGoal } from "../context/governor.js"
import { resolveSessionIdentity, type SessionIdentitySource } from "../context/session-identity.js"
import { FilesystemContentStore } from "../eviction/store.js"
import { discoverRuntimeContext } from "../runtime/discovery.js"
import type { ChatCompletionRequest } from "../types/openai.js"
import { LMStudioTokenProvider, GenericConservativeProvider, createTokenMeasurementProvider, type TokenMeasurement } from "../context/providers/index.js"
import type { EngineConfig, TokenEstimatorMode } from "../config.js"

export interface RequestMetrics {
  requestTokensBefore?: number
  requestTokensAfter?: number
  safeInput?: number
  physical_context?: number
  effective_context?: number
  requested_output_tokens?: number
  output_reserve_effective?: number
  safety_reserve?: number
  safe_input?: number
  reclaimedTokens?: number
  numberOfEvictions?: number
  physicalContext?: number
  effectiveContext?: number
  contextSource?: "loaded" | "configured"
  requestedOutputTokens?: number
  outputReserveEffective?: number
  outputReserve?: number
  safetyReserve?: number
  estimatorConfidence?: EstimatorConfidence
  governorTriggered?: boolean
  governorEmergency?: boolean
  governorArmedBefore?: boolean
  governorArmedAfter?: boolean
  governorTargetTokens?: number
  governorMode?: "protect" | "govern"
  tokenEstimatorMode?: TokenEstimatorMode
  measurement_source?: string
  measurement_confidence?: "exact" | "approximate"
  initial_measurement_source?: string
  initial_measurement_confidence?: "exact" | "approximate"
  final_measurement_source?: string
  final_measurement_confidence?: "exact" | "approximate"
  authoritative_input_tokens?: number
  authoritative_input_tokens_before?: number
  authoritative_input_tokens_after?: number
  static_tokens?: number
  runtime_tokens?: number
  estimator_delta?: number
  estimator_ratio?: number
  runtime_estimator_latency_ms?: number
  token_breakdown_before?: TokenBreakdown
  token_breakdown_after?: TokenBreakdown
  live_evidence_tokens_before?: number
  live_evidence_tokens_after?: number
  live_evidence_evictions?: number
  live_evidence_archived_tokens?: number
  session_key_hash?: string
  session_identity_source?: SessionIdentitySource
  streamCompleted?: boolean
  streamDoneMarkerSeen?: boolean
  streamFinishReasonSeen?: boolean
  clientAborted?: boolean
  forwardingDecision: "forwarded" | "context_budget_exceeded" | "context_unknown" | "invalid_request" | "upstream_error" | "token_measurement_unavailable"
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

function requestedOutputTokens(payload: ChatCompletionRequest): number | undefined {
  const requested = Number(payload.max_completion_tokens ?? payload.max_tokens)
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : undefined
}

function outputReserve(payload: ChatCompletionRequest, configured: number): number {
  return requestedOutputTokens(payload) ?? configured
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

interface ReductionResult {
  request: ChatCompletionRequest
  beforeTokens: number
  afterTokens: number
  reclaimedTokens: number
  evictions: Array<{
    originalTokens: number
    retainedTokens: number
    reductionClass: "SAFE" | "LIVE_EVIDENCE"
  }>
  fits: boolean
}

function recordLiveEvidenceMetrics(metrics: RequestMetrics, result: ReductionResult, afterBreakdown: TokenBreakdown): void {
  const liveEvictions = result.evictions.filter((eviction) => eviction.reductionClass === "LIVE_EVIDENCE")
  metrics.live_evidence_tokens_after = afterBreakdown.current_tool_results
  metrics.live_evidence_evictions = liveEvictions.length
  metrics.live_evidence_archived_tokens = liveEvictions.reduce(
    (sum, eviction) => sum + Math.max(0, eviction.originalTokens - eviction.retainedTokens),
    0,
  )
}

export function createGatewayServer(
  config: EngineConfig,
  metricsSink: (metrics: RequestMetrics) => void = () => undefined,
): Server {
  const store = new FilesystemContentStore(config.storeRoot)
  const governor = new MultiSessionGovernor()
  const lmstudioProvider = new LMStudioTokenProvider({ baseUrl: config.upstreamBaseUrl })
  const tokenMeasurementProvider = createTokenMeasurementProvider(
    [
      { capability: "lmstudio", create: () => lmstudioProvider },
    ],
    new GenericConservativeProvider((request) => estimateRequestTokens(request, new CharacterTokenEstimator()))
  )
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
        const providerMode = config.tokenEstimatorMode ?? "static"
        metrics.tokenEstimatorMode = providerMode
        metrics.estimatorConfidence = estimator.confidence

        const discovered = await discoverRuntimeContext(config.upstreamBaseUrl, payload.model)

        const getMeasurement = async (req: ChatCompletionRequest): Promise<TokenMeasurement | undefined> => {
          if (providerMode === "auto") {
            if (discovered?.runtimeKind === "lmstudio" || discovered?.runtimeKind === undefined) {
              try {
                const measurement = await tokenMeasurementProvider.estimateChatRequest(req)
                if (measurement !== undefined) return measurement
              } catch {}
            }
          }
          return {
            tokens: estimateRequestTokens(req, estimator),
            source: "generic_character",
            confidence: "approximate",
          }
        }

        const initialMeasurement = await getMeasurement(payload)
        if (initialMeasurement === undefined) {
          metrics.forwardingDecision = "token_measurement_unavailable"
          json(response, 500, { error: { type: "token_measurement_unavailable", message: "Initial token measurement failed." } })
          return
        }

        const requiredConfidence = initialMeasurement.confidence
        let latestMeasurement = initialMeasurement

        const measureRequest = async (req: ChatCompletionRequest): Promise<{ tokens: number; source: string; confidence: "exact" | "approximate" }> => {
          const m = await getMeasurement(req)
          if (m === undefined || m.confidence !== requiredConfidence) {
            throw new Error("token_measurement_unavailable")
          }
          latestMeasurement = m
          return m
        }

        metrics.measurement_source = initialMeasurement.source
        metrics.measurement_confidence = initialMeasurement.confidence
        metrics.initial_measurement_source = initialMeasurement.source
        metrics.initial_measurement_confidence = initialMeasurement.confidence
        metrics.authoritative_input_tokens = initialMeasurement.tokens
        metrics.authoritative_input_tokens_before = initialMeasurement.tokens
        metrics.requestTokensBefore = initialMeasurement.tokens
        metrics.token_breakdown_before = estimateTokenBreakdown(payload, estimator)
        metrics.live_evidence_tokens_before = metrics.token_breakdown_before.current_tool_results

        if (providerMode === "shadow") {
          const t0 = performance.now()
          try {
            const shadowMeasurement = await tokenMeasurementProvider.estimateChatRequest(payload)
            metrics.runtime_estimator_latency_ms = Math.round(performance.now() - t0)
            metrics.static_tokens = metrics.requestTokensBefore
            if (shadowMeasurement !== undefined) {
              metrics.runtime_tokens = shadowMeasurement.tokens
              metrics.estimator_delta = metrics.static_tokens - shadowMeasurement.tokens
              metrics.estimator_ratio = shadowMeasurement.tokens > 0 ? metrics.static_tokens / shadowMeasurement.tokens : 0
            }
          } catch (e) {
            process.stderr.write(`Runtime estimator failed: ${e instanceof Error ? e.message : String(e)}\n`)
            metrics.runtime_estimator_latency_ms = Math.round(performance.now() - t0)
          }
        }
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
        const requestedOutput = requestedOutputTokens(payload)
        const requestedOutputReserve = outputReserve(payload, config.outputReserve)
        const requestedSafetyReserve = configuredSafetyReserve(effectiveContext, config.safetyReserve)
        metrics.physicalContext = effectiveContext
        metrics.effectiveContext = effectiveContext
        metrics.physical_context = effectiveContext
        metrics.effective_context = effectiveContext
        metrics.contextSource = contextSource
        if (requestedOutput !== undefined) {
          metrics.requestedOutputTokens = requestedOutput
          metrics.requested_output_tokens = requestedOutput
        }
        metrics.outputReserveEffective = requestedOutputReserve
        metrics.output_reserve_effective = requestedOutputReserve
        metrics.outputReserve = requestedOutputReserve
        metrics.safetyReserve = requestedSafetyReserve
        metrics.safety_reserve = requestedSafetyReserve
        metrics.governorMode = config.governorMode ?? "govern"
        const safeInput = effectiveContext - requestedOutputReserve - requestedSafetyReserve
        if (safeInput <= 0) {
          metrics.safeInput = 0
          metrics.safe_input = 0
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
        metrics.safe_input = budget.safeInput

        const identity = resolveSessionIdentity({
          headers: request.headers,
          payload,
          ...(request.socket.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
          ...(config.sessionIdentityHeader === undefined ? {} : { configuredHeader: config.sessionIdentityHeader }),
        })
        metrics.session_identity_source = identity.source
        if (identity.sessionKeyHash !== undefined) metrics.session_key_hash = identity.sessionKeyHash

        const unchanged = (): ReductionResult => ({
          request: payload,
          beforeTokens: metrics.requestTokensBefore!,
          afterTokens: metrics.requestTokensBefore!,
          reclaimedTokens: 0,
          evictions: [],
          fits: true,
        })
        const reduceForGoal = async (goal: ReductionGoal): Promise<ReductionResult> => {
          if (!goal.shouldReduce && metrics.requestTokensBefore! <= budget.safeInput) return unchanged()
          const targetTokens = goal.shouldReduce ? goal.targetTokens : budget.safeInput
          return reduceRequestToBudget(payload, budget, store, { estimator, measureRequest, targetTokens })
        }

        let reduced: ReductionResult
        if ((config.governorMode ?? "govern") === "protect") {
          metrics.governorTriggered = false
          reduced = metrics.requestTokensBefore <= budget.safeInput
            ? unchanged()
            : await reduceRequestToBudget(payload, budget, store, { estimator, measureRequest, targetTokens: budget.safeInput })
        } else if (identity.governorKey === undefined) {
          const statelessGovernor = new MultiSessionGovernor()
          const state = statelessGovernor.getOrCreateState("request")
          metrics.governorArmedBefore = state.armed
          const goal = statelessGovernor.evaluate("request", metrics.requestTokensBefore, budget)
          metrics.governorTriggered = goal.shouldReduce
          metrics.governorEmergency = goal.isEmergency
          metrics.governorTargetTokens = goal.targetTokens
          reduced = await reduceForGoal(goal)
          if (reduced.evictions.length > 0) statelessGovernor.updateAfterReduction("request", reduced.beforeTokens, reduced.afterTokens)
          metrics.governorArmedAfter = state.armed
        } else {
          reduced = await governor.runExclusive(identity.governorKey, metrics.requestTokensBefore, budget, async ({ goal, armedBefore, updateAfterReduction }) => {
            metrics.governorArmedBefore = armedBefore
            metrics.governorTriggered = goal.shouldReduce
            metrics.governorEmergency = goal.isEmergency
            metrics.governorTargetTokens = goal.targetTokens
            const result = await reduceForGoal(goal)
            if (result.evictions.length > 0) updateAfterReduction(result.beforeTokens, result.afterTokens)
            metrics.governorArmedAfter = governor.getOrCreateState(identity.governorKey!).armed
            return result
          })
        }
        outgoingBody = reduced.evictions.length === 0
          ? incomingBody
          : Buffer.from(JSON.stringify(reduced.request))
        metrics.requestTokensBefore = reduced.beforeTokens
        metrics.requestTokensAfter = reduced.afterTokens
        metrics.authoritative_input_tokens = reduced.afterTokens
        metrics.authoritative_input_tokens_after = reduced.afterTokens
        metrics.final_measurement_source = latestMeasurement.source
        metrics.final_measurement_confidence = latestMeasurement.confidence
        metrics.token_breakdown_after = estimateTokenBreakdown(reduced.request, estimator)
        recordLiveEvidenceMetrics(metrics, reduced, metrics.token_breakdown_after)
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
        metrics.token_breakdown_after = estimateTokenBreakdown(error.result.request)
        recordLiveEvidenceMetrics(metrics, error.result, metrics.token_breakdown_after)
        metrics.reclaimedTokens = error.result.reclaimedTokens
        metrics.numberOfEvictions = error.result.evictions.length
        metrics.physicalContext = error.budget.effectiveContext
        metrics.effectiveContext = error.budget.effectiveContext
        metrics.physical_context = error.budget.effectiveContext
        metrics.effective_context = error.budget.effectiveContext
        metrics.outputReserveEffective = error.budget.outputReserve
        metrics.output_reserve_effective = error.budget.outputReserve
        metrics.outputReserve = error.budget.outputReserve
        metrics.safetyReserve = error.budget.safetyReserve
        metrics.safety_reserve = error.budget.safetyReserve
        metrics.safeInput = error.budget.safeInput
        metrics.safe_input = error.budget.safeInput
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
      if (error instanceof Error && error.message === "token_measurement_unavailable") {
        metrics.forwardingDecision = "token_measurement_unavailable"
        json(response, 500, {
          error: {
            type: "token_measurement_unavailable",
            message: "Exact token measurement became unavailable during reduction.",
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
