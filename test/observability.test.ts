import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { configFromEnvironment } from "../src/config.js"
import { createJsonlMetricsSink, type JsonlMetricRecord } from "../src/observability/jsonl.js"

test("configures JSONL metrics only when explicitly enabled", () => {
  assert.equal(configFromEnvironment({}).metricsJsonlPath, undefined)
  assert.equal(
    configFromEnvironment({ CONTEXT_ENGINE_METRICS_JSONL: "metrics/requests.jsonl" }).metricsJsonlPath,
    "metrics/requests.jsonl",
  )
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
      outputReserve: 4_096,
      safetyReserve: 2_048,
      safeInput: 18_856,
      reclaimedTokens: 22_000,
      numberOfEvictions: 3,
      estimatorConfidence: "conservative",
      forwardingDecision: "forwarded",
    })

    const lines = (await readFile(file, "utf8")).trim().split("\n")
    const record = JSON.parse(lines[0]!) as JsonlMetricRecord & Record<string, unknown>
    assert.equal(lines.length, 1)
    assert.equal(record.schema, "local-context-engine.request.v1")
    assert.equal(record.forwardingDecision, "forwarded")
    assert.equal(record.safeInput, 18_856)
    assert.ok(record.recordedAt)
    assert.equal(record.messages, undefined)
    assert.equal(record.content, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
