# Local Context Engine

A transparent OpenAI-compatible gateway that prevents agent requests from exceeding the context physically loaded by a local inference runtime.

Every chat request follows a strict path:

```text
Measure → Budget → Evict → Verify → Forward
```

The gateway conservatively measures the complete request, reserves output and safety capacity, archives old large tool results when necessary, verifies the reduced request, and fails locally if it still cannot fit. Oversized requests are never forwarded upstream.

## Status

Daily driver stabilization release (v0.2 ready). Provides transparent OpenAI-compatible proxying, exact LM Studio runtime token measurement, and conservative generic fallback.

## Validated Runtimes & Adapters

- **LM Studio**: Exact token measurement via `@lmstudio/sdk` (`TokenMeasurementProvider`), matching native `prompt_tokens`.
- **Generic / OpenAI-compatible**: Conservative character-based fallback for unvalidated runtimes.
- **Planned / Community roadmap**: Ollama, oMLX, llama.cpp, vLLM.

## Requirements

- Node.js 22 or newer
- An OpenAI-compatible inference runtime such as LM Studio

## Install and validate

```bash
npm install
npm run check
npm run build
npm link
```

## Recommended Daily Driver Usage

```bash
CONTEXT_ENGINE_UPSTREAM_URL=http://127.0.0.1:1234/v1 \
CONTEXT_GOVERNOR_MODE=govern \
CONTEXT_TOKEN_ESTIMATOR=auto \
CONTEXT_OUTPUT_RESERVE=4096 \
CONTEXT_SAFETY_RESERVE=2048 \
local-context-engine
```

The gateway listens on `http://127.0.0.1:18181/v1` by default. Configure Kilo or any OpenAI-compatible client to point to `http://127.0.0.1:18181/v1`.

If LM Studio is running, the engine automatically discovers physical loaded context and uses exact LM Studio prompt token measurement for budgeting, eviction, and verification.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXT_ENGINE_HOST` | `127.0.0.1` | Gateway bind address |
| `CONTEXT_ENGINE_PORT` | `18181` | Gateway port |
| `CONTEXT_ENGINE_UPSTREAM_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible upstream base URL |
| `CONTEXT_WINDOW_TOKENS` | unset | Conservative fallback when loaded context discovery fails |
| `CONTEXT_GOVERNOR_MODE` | `govern` | `protect` disables preventive eviction; `govern` enables SAFE-only watermarks |
| `CONTEXT_OUTPUT_RESERVE` | `4096` | Default output-token reserve; a valid client `max_completion_tokens` or `max_tokens` takes precedence |
| `CONTEXT_SAFETY_RESERVE` | 8% of context, minimum `2048` | Estimation uncertainty reserve |
| `CONTEXT_ENGINE_STORE` | `~/.local-context-engine/store` | Content-addressed archive directory |
| `CONTEXT_ENGINE_MAX_REQUEST_BYTES` | `16777216` | Maximum request body size |
| `CONTEXT_TOKEN_ESTIMATOR` | `auto` | `auto` uses exact provider when available with fallback to generic; `static` forces character estimator; `shadow` uses character estimator for decisions while recording exact measurements. |
| `CONTEXT_ENGINE_METRICS_JSONL` | `~/.local-context-engine/metrics.jsonl` | Metadata-only request metrics file; set `false` or empty to disable |

Metrics contain numeric request composition, governor decisions, reserves, budgets, eviction counts, forwarding outcomes, and hashed session identity. They do not contain message, tool, argument, or result content.

### Shadow estimator validation

`CONTEXT_TOKEN_ESTIMATOR=shadow` is validated as 100% observational: budget decisions, reducer measurements, and final verification remain controlled by `CharacterTokenEstimator`; the LM Studio runtime estimator contributes metrics only. The `LMStudioRuntimeEstimator` matched LM Studio's own `usage.prompt_tokens` exactly in controlled baseline, tool-results, post-`LIVE_EVIDENCE`, and assistant-history scenarios, including an actual `assistant.tool_calls[]` → `tool`/`tool_call_id` → `function.arguments` sequence with tool definitions. Observed runtime-estimator latency was approximately 21–73 ms.

The `CharacterTokenEstimator` showed both overestimation and underestimation, and must not be treated as safety-authoritative for tool-heavy prompts. Promotion to `runtime` authority is explicitly deferred to the next phase; runtime authority is not enabled in this phase. Reducer, governor, CAS, `LIVE_EVIDENCE`, and pruning behavior remain unchanged.

## Controlled Kilo + LM Studio experiment

Build once, load the same model in LM Studio with `physical_context=25088`, and point the same Kilo OpenAI-compatible provider configuration at `http://127.0.0.1:18181/v1`. Keep model, prompt, tools, Kilo configuration, and client output fields identical between runs. Start a fresh Kilo session for each run and repeat the exact task from `session-ses_fffe2`.

Test A:

```bash
CONTEXT_ENGINE_UPSTREAM_URL=http://127.0.0.1:1234/v1 \
CONTEXT_WINDOW_TOKENS=25088 \
CONTEXT_GOVERNOR_MODE=protect \
CONTEXT_OUTPUT_RESERVE=8192 \
CONTEXT_SAFETY_RESERVE=2048 \
CONTEXT_ENGINE_METRICS_JSONL="$PWD/metrics-protect-8192.jsonl" \
node dist/src/cli.js
```

Test B, after stopping Test A:

```bash
CONTEXT_ENGINE_UPSTREAM_URL=http://127.0.0.1:1234/v1 \
CONTEXT_WINDOW_TOKENS=25088 \
CONTEXT_GOVERNOR_MODE=govern \
CONTEXT_OUTPUT_RESERVE=8192 \
CONTEXT_SAFETY_RESERVE=2048 \
CONTEXT_ENGINE_METRICS_JSONL="$PWD/metrics-govern-8192.jsonl" \
node dist/src/cli.js
```

If Kilo sends `max_completion_tokens` or `max_tokens`, that value becomes `output_reserve_effective`; keep it identical in both runs. The configured `8192` is used only when neither field is valid. Save both fresh transcripts with their corresponding JSONL files.

Only after this initial A/B, run the separate reserve axis with the selected governor mode held constant. For run A, preserve the client's current effective output field and record its resulting `output_reserve_effective`; for run B, set the same client's `max_tokens=4096`. Use fresh sessions and distinct JSONL paths, and do not compare outcomes until both transcripts and metrics are saved. With `physical_context=25088` and `safety_reserve=2048`, run B has `safe_input=18944`; run A must use the value recorded from the actual request rather than an environment default overridden by the client.

## Health check

```bash
curl http://127.0.0.1:18181/health
```

## Scope

The core provides transport preservation, loaded-context discovery, conservative request measurement, hard budgeting, deterministic tool-output eviction, content-addressed archival, verification, fail-closed errors, and metadata-only observability.

It intentionally does not implement agent orchestration, behavioral prompts, semantic summarization, MCP, or runtime-specific workflow policy. See [`PLAN.md`](PLAN.md) for architecture and roadmap details.

## License

Licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
