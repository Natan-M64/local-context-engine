# Local Context Engine

A transparent OpenAI-compatible gateway that prevents agent requests from exceeding the context physically loaded by a local inference runtime.

Every chat request follows a strict path:

```text
Measure → Budget → Evict → Verify → Forward
```

The gateway conservatively measures the complete request, reserves output and safety capacity, archives old large tool results when necessary, verifies the reduced request, and fails locally if it still cannot fit. Oversized requests are never forwarded upstream.

## Status

Early v0.1 implementation. The repository is private while transport compatibility and runtime discovery are validated across local inference servers.

## Requirements

- Node.js 22 or newer
- An OpenAI-compatible inference runtime such as LM Studio

## Install and validate

```bash
npm install
npm run check
npm run build
```

## Run locally

```bash
CONTEXT_ENGINE_UPSTREAM_URL=http://127.0.0.1:1234/v1 \
CONTEXT_OUTPUT_RESERVE=4096 \
CONTEXT_SAFETY_RESERVE=2048 \
node dist/src/cli.js
```

The gateway listens on `http://127.0.0.1:18181/v1` by default. Configure an OpenAI-compatible client to use that base URL instead of the runtime URL.

If the runtime does not report the context physically loaded for the selected model, set a conservative fallback:

```bash
CONTEXT_WINDOW_TOKENS=25088 node dist/src/cli.js
```

## Local network access

Bind the gateway to all network interfaces:

```bash
CONTEXT_ENGINE_HOST=0.0.0.0 \
CONTEXT_ENGINE_PORT=18181 \
CONTEXT_ENGINE_UPSTREAM_URL=http://127.0.0.1:1234/v1 \
CONTEXT_OUTPUT_RESERVE=4096 \
CONTEXT_SAFETY_RESERVE=2048 \
node dist/src/cli.js
```

Other devices on the same network can then use `http://<host-lan-ip>:18181/v1`. The upstream runtime can remain bound to loopback because the gateway accesses it on the same host.

The gateway currently has no authentication or TLS. Expose it only on a trusted local network, restrict port `18181` with the host firewall, and do not port-forward it to the internet.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXT_ENGINE_HOST` | `127.0.0.1` | Gateway bind address |
| `CONTEXT_ENGINE_PORT` | `18181` | Gateway port |
| `CONTEXT_ENGINE_UPSTREAM_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible upstream base URL |
| `CONTEXT_WINDOW_TOKENS` | unset | Conservative fallback when loaded context discovery fails |
| `CONTEXT_OUTPUT_RESERVE` | `4096` | Default output-token reserve |
| `CONTEXT_SAFETY_RESERVE` | 8% of context, minimum `2048` | Estimation uncertainty reserve |
| `CONTEXT_ENGINE_STORE` | `~/.local-context-engine/store` | Content-addressed archive directory |
| `CONTEXT_ENGINE_MAX_REQUEST_BYTES` | `16777216` | Maximum request body size |
| `CONTEXT_ENGINE_METRICS_JSONL` | unset | Optional metadata-only request metrics file |

## Health check

```bash
curl http://127.0.0.1:18181/health
```

## Scope

The core provides transport preservation, loaded-context discovery, conservative request measurement, hard budgeting, deterministic tool-output eviction, content-addressed archival, verification, fail-closed errors, and metadata-only observability.

It intentionally does not implement agent orchestration, behavioral prompts, semantic summarization, MCP, or runtime-specific workflow policy. See [`PLAN.md`](PLAN.md) for architecture and roadmap details.

## License

Licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
