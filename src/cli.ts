#!/usr/bin/env node
import { configFromEnvironment } from "./config.js"
import { createGatewayServer } from "./gateway/server.js"
import { createJsonlMetricsSink } from "./observability/jsonl.js"

const config = configFromEnvironment()
const metricsSink = config.metricsJsonlPath === undefined ? undefined : createJsonlMetricsSink(config.metricsJsonlPath)
const server = metricsSink === undefined
  ? createGatewayServer(config)
  : createGatewayServer(config, metricsSink)

server.listen(config.port, config.host, () => {
  process.stderr.write(`local-context-engine listening on http://${config.host}:${config.port}/v1 -> ${config.upstreamBaseUrl}\n`)
})

function shutdown(): void {
  server.close(() => process.exit(0))
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
