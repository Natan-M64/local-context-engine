import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { configFromEnvironment } from "../src/config.js"
import { createJsonlMetricsSink, type JsonlMetricRecord } from "../src/observability/jsonl.js"

test("configures JSONL metrics with opt-out capability and stable identity header", () => {
  assert.equal(configFromEnvironment({}).metricsJsonlPath, path.join(os.homedir(), ".local-context-engine", "metrics.jsonl"))
  assert.equal(configFromEnvironment({ CONTEXT_ENGINE_METRICS_JSONL: "false" }).metricsJsonlPath, undefined)
  assert.equal(configFromEnvironment({ CONTEXT_ENGINE_METRICS_JSONL: "" }).metricsJsonlPath, undefined)
  const configured = configFromEnvironment({
    CONTEXT_ENGINE_METRICS_JSONL: "metrics/requests.jsonl",
    CONTEXT_ENGINE_SESSION_HEADER: "x-client-conversation",
  })
  assert.equal(configured.metricsJsonlPath, "metrics/requests.jsonl")
  assert.equal(configured.sessionIdentityHeader, "x-client-conversation")
  assert.equal(configFromEnvironment({}).governorMode, "govern")
  assert.equal(configFromEnvironment({ CONTEXT_GOVERNOR_MODE: "protect" }).governorMode, "protect")
  assert.throws(() => configFromEnvironment({ CONTEXT_GOVERNOR_MODE: "invalid" }), /protect or govern/)
})

test("writes metadata-only request metrics as JSONL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-metrics-"))
  const file = path.join(root, "nested", "requests.jsonl")
  try {
    const sink = createJsonlMetricsSink(file)
    sink({
      requestTokensBefore: 40_000,
      requestTokensAfter: 18_000,
      effectiveContext: 25_000,
      requestedOutputTokens: 8_192,
      outputReserveEffective: 8_192,
      outputReserve: 8_192,
      safetyReserve: 2_048,
      safeInput: 18_856,
      reclaimedTokens: 22_000,
      numberOfEvictions: 3,
      estimatorConfidence: "conservative",
      session_key_hash: "a".repeat(64),
      session_identity_source: "explicit",
      governorMode: "protect",
      live_evidence_tokens_before: 6,
      live_evidence_tokens_after: 2,
      live_evidence_evictions: 1,
      live_evidence_archived_tokens: 4,
      token_breakdown_before: {
        system_messages: 1,
        user_messages: 2,
        assistant_content: 3,
        assistant_tool_calls: 4,
        assistant_tool_call_arguments: 5,
        current_tool_results: 6,
        old_tool_results: 7,
        tool_definitions: 8,
        tool_descriptions: 9,
        request_other: 10,
        unattributed_tokens: 11,
      },
      forwardingDecision: "forwarded",
    })

    const lines = (await readFile(file, "utf8")).trim().split("\n")
    const record = JSON.parse(lines[0]!) as JsonlMetricRecord & Record<string, unknown>
    assert.equal(lines.length, 1)
    assert.equal(record.schema, "local-context-engine.request.v1")
    assert.equal(record.forwardingDecision, "forwarded")
    assert.equal(record.safeInput, 18_856)
    assert.equal(record.session_key_hash, "a".repeat(64))
    assert.equal(record.session_identity_source, "explicit")
    assert.equal(record.requestedOutputTokens, 8_192)
    assert.equal(record.outputReserveEffective, 8_192)
    assert.equal(record.token_breakdown_before?.current_tool_results, 6)
    assert.equal(record.token_breakdown_before?.old_tool_results, 7)
    assert.equal(record.live_evidence_tokens_before, 6)
    assert.equal(record.live_evidence_tokens_after, 2)
    assert.equal(record.live_evidence_evictions, 1)
    assert.equal(record.live_evidence_archived_tokens, 4)
    assert.ok(record.recordedAt)
    assert.equal(record.messages, undefined)
    assert.equal(record.content, undefined)
    assert.equal(JSON.stringify(record).includes("session-A"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
