import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { RequestMetrics } from "../gateway/server.js"

export interface JsonlMetricRecord extends RequestMetrics {
  schema: "local-context-engine.request.v1"
  recordedAt: string
}

export type MetricsSink = (metrics: RequestMetrics) => void

export function createJsonlMetricsSink(filePath: string): MetricsSink {
  if (filePath.length === 0) throw new RangeError("metrics JSONL path must not be empty")
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
  return (metrics) => {
    const record: JsonlMetricRecord = {
      schema: "local-context-engine.request.v1",
      recordedAt: new Date().toISOString(),
      ...metrics,
    }
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
  }
}
