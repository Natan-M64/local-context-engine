import os from "node:os"
import path from "node:path"

export interface EngineConfig {
  host: string
  port: number
  upstreamBaseUrl: string
  contextWindow?: number
  outputReserve: number
  safetyReserve?: number
  storeRoot: string
  maxRequestBytes: number
  metricsJsonlPath?: string
}

function positiveInteger(value: string | undefined): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

export function configFromEnvironment(environment: NodeJS.ProcessEnv = process.env): EngineConfig {
  const contextWindow = positiveInteger(environment.CONTEXT_WINDOW_TOKENS)
  const safetyReserve = positiveInteger(environment.CONTEXT_SAFETY_RESERVE)
  return {
    host: environment.CONTEXT_ENGINE_HOST ?? "127.0.0.1",
    port: positiveInteger(environment.CONTEXT_ENGINE_PORT) ?? 18_181,
    upstreamBaseUrl: environment.CONTEXT_ENGINE_UPSTREAM_URL ?? "http://127.0.0.1:1234/v1",
    ...(contextWindow === undefined ? {} : { contextWindow }),
    outputReserve: positiveInteger(environment.CONTEXT_OUTPUT_RESERVE) ?? 4_096,
    ...(safetyReserve === undefined ? {} : { safetyReserve }),
    storeRoot: environment.CONTEXT_ENGINE_STORE ?? path.join(os.homedir(), ".local-context-engine", "store"),
    maxRequestBytes: positiveInteger(environment.CONTEXT_ENGINE_MAX_REQUEST_BYTES) ?? 16 * 1024 * 1024,
    ...(environment.CONTEXT_ENGINE_METRICS_JSONL === undefined ? {} : { metricsJsonlPath: environment.CONTEXT_ENGINE_METRICS_JSONL }),
  }
}
