# Local Context Engine

[![CI](https://github.com/Natan-M64/local-context-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/Natan-M64/local-context-engine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Natan-M64/local-context-engine?include_prereleases&style=flat-square&color=blue)](https://github.com/Natan-M64/local-context-engine/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha.1--daily--testing-orange?style=flat-square)](VALIDATION.md)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue?style=flat-square)](package.json)

A transparent OpenAI-compatible gateway for constrained-context local LLMs.

Every chat request follows one hard path:

```text
Measure → Budget → Evict/Reduce → Verify → Forward
```

The engine measures the complete request, reserves output and safety capacity, performs deterministic recoverable reduction when needed, verifies the transformed request, and fails locally when no safe reduction is available. An oversized request must never be forwarded upstream.

## Status

**v0.2.0-alpha.1 — daily-driver testing**

This release is intended for real-world testing, not as a claim that long-running local agents can operate indefinitely inside a small context window. The alpha focuses on transport correctness, exact budgeting where validated, deterministic context reduction, fail-closed behavior, and observability.

### Validated

- OpenAI-compatible Chat Completions proxying;
- `GET /v1/models` passthrough;
- LM Studio loaded-context discovery;
- exact LM Studio prompt measurement via `@lmstudio/sdk`;
- deterministic old-tool-result archival using a filesystem content-addressed store;
- authoritative before/after measurement for reduction decisions;
- fail-closed hard budgeting;
- historical tool-argument archival under hard overflow;
- optional streamed reasoning compatibility mode;
- streaming termination, cancellation, headers, tool-call IDs and pairing preservation;
- metadata-only JSONL request metrics.

### Experimental

- preventive governor/watermark behavior;
- `LIVE_EVIDENCE` reduction under hard overflow;
- emergency archive-marker compaction;
- long-running agent continuity under extreme tool-output pressure.

See [`VALIDATION.md`](VALIDATION.md) for current real-world observations and release criteria.

## Validated runtimes and adapters

- **LM Studio** — validated exact token measurement through `@lmstudio/sdk` (`TokenMeasurementProvider`).
- **Generic / OpenAI-compatible** — approximate character-based fallback for unvalidated runtimes.
- **Planned / community** — Ollama, oMLX, llama.cpp, vLLM.

Runtime-specific measurement and discovery belong behind small adapters. Core budgeting and reduction policy must remain runtime-agnostic.

## Requirements

- Node.js 22 or newer;
- an OpenAI-compatible inference runtime such as LM Studio.

## Install and validate

```bash
npm install
npm run check
npm run build
npm link
```

The CLI is then available as:

```bash
local-context-engine
```

The gateway listens on `http://127.0.0.1:18181/v1` by default. Point Kilo, OpenCode, or another OpenAI-compatible client to that URL instead of directly to the inference runtime.

## Daily-driver testing profile

For the currently validated LM Studio exact-measurement path:

### macOS / Linux (bash / zsh)

```bash
CONTEXT_ENGINE_UPSTREAM_URL="http://127.0.0.1:1234/v1" \
CONTEXT_GOVERNOR_MODE="govern" \
CONTEXT_TOKEN_ESTIMATOR="auto" \
CONTEXT_OUTPUT_RESERVE="4096" \
CONTEXT_SAFETY_RESERVE="512" \
CONTEXT_REASONING_STREAM="strip" \
local-context-engine
```

### Windows (PowerShell)

```powershell
$env:CONTEXT_ENGINE_UPSTREAM_URL="http://127.0.0.1:1234/v1"
$env:CONTEXT_GOVERNOR_MODE="govern"
$env:CONTEXT_TOKEN_ESTIMATOR="auto"
$env:CONTEXT_OUTPUT_RESERVE="4096"
$env:CONTEXT_SAFETY_RESERVE="512"
$env:CONTEXT_REASONING_STREAM="strip"
local-context-engine
```

`CONTEXT_SAFETY_RESERVE=512` is a **daily-test profile for the validated exact LM Studio path**, not a universal default recommendation. Approximate/unvalidated measurement should retain a more conservative reserve.

`CONTEXT_REASONING_STREAM=strip` is an opt-in compatibility workaround for streamed reasoning preceding tool calls; `passthrough` remains the default.

If the client sends a valid `max_completion_tokens` or `max_tokens`, that value becomes the effective output reserve and takes precedence over `CONTEXT_OUTPUT_RESERVE`.

For a 25,088-token loaded context with a 4,096-token output reserve and a 512-token safety reserve:

```text
safe_input = 25088 - 4096 - 512 = 20480
```

Do not set `CONTEXT_WINDOW_TOKENS` during normal LM Studio use when loaded-context discovery is working. It is a fallback when runtime discovery is unavailable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXT_ENGINE_HOST` | `127.0.0.1` | Gateway bind address |
| `CONTEXT_ENGINE_PORT` | `18181` | Gateway port |
| `CONTEXT_ENGINE_UPSTREAM_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible upstream base URL |
| `CONTEXT_WINDOW_TOKENS` | unset | Explicit fallback when loaded context discovery fails |
| `CONTEXT_GOVERNOR_MODE` | `govern` | `protect` disables preventive reduction; `govern` enables watermarks/hysteresis |
| `CONTEXT_OUTPUT_RESERVE` | `4096` | Default output reserve; client output fields take precedence |
| `CONTEXT_SAFETY_RESERVE` | 8% of context, minimum `2048` | Configured safety/uncertainty reserve; daily exact-LM-Studio testing currently uses `512` explicitly |
| `CONTEXT_ENGINE_STORE` | `~/.local-context-engine/store` | Content-addressed archive directory |
| `CONTEXT_ENGINE_MAX_REQUEST_BYTES` | `16777216` | Maximum request body size |
| `CONTEXT_TOKEN_ESTIMATOR` | `auto` | `auto`, `static`, or observational `shadow` mode |
| `CONTEXT_REASONING_STREAM` | `passthrough` | `passthrough` or opt-in `strip` for streamed `reasoning_content` |
| `CONTEXT_ENGINE_METRICS_JSONL` | `~/.local-context-engine/metrics.jsonl` | Metadata-only JSONL metrics; set false/empty to disable |

## Token measurement

Token accounting is exposed through a replaceable `TokenMeasurementProvider` with explicit confidence:

```text
exact
approximate
```

In `auto`, a validated exact provider is authoritative for the entire request. If exact measurement becomes unavailable during that same request, the gateway fails closed with `token_measurement_unavailable`; it must not silently downgrade to approximate measurement.

The category breakdown in metrics is heuristic/approximate even when the whole-request measurement is exact.

## Reasoning stream compatibility

Tests with Kilo/OpenCode, `@ai-sdk/openai-compatible`, LM Studio and reasoning-capable local models reproduced a lifecycle incompatibility where streamed `reasoning_content` preceding tool calls could lead to `Tool execution aborted` or a turn ending without a useful completion.

The exact cause has not been attributed universally to LM Studio, Kilo, the AI SDK, or any model family.

`CONTEXT_REASONING_STREAM=passthrough` is the transparent default. For combinations that reproduce the issue, `CONTEXT_REASONING_STREAM=strip` removes only downstream `choices[*].delta.reasoning_content` from streaming Chat Completions while the model continues reasoning upstream. Content, tool calls, fragmented tool arguments, finish reasons, usage, event metadata and `[DONE]` remain preserved. Non-streaming responses are unchanged.

This is an interoperability workaround, not a general protocol fix.

## Hard-overflow behavior

Reduction is deterministic and recoverable. A candidate is accepted only when authoritative whole-request measurement proves that the request became smaller.

Current ordering prioritizes old deterministic tool output before touching current evidence. Historical assistant tool-call arguments may be archived only under hard overflow. Current tool-call arguments, system/developer instructions, the latest user requirements, tool schemas/descriptions, protocol IDs and pairing remain protected by the current policy.

`LIVE_EVIDENCE` is considered only under hard overflow. If deterministic reduction still cannot reach `safe_input`, the gateway returns `context_budget_exceeded` and does not contact the upstream runtime.

A local `context_budget_exceeded` is therefore not automatically a gateway failure. It is a correct fail-closed outcome unless an allowed deterministic reduction was missed or an oversized request reached upstream.

## Known limitations

- The engine does not prevent model- or agent-level behavioral loops such as repeatedly issuing materially equivalent `grep`, `bash`, or search calls.
- Harness step limits and empty/terminal model responses remain client/model concerns.
- Extremely tool-heavy sessions can exhaust the irreducible protected/protocol footprint and legitimately return `context_budget_exceeded`.
- Very large current tool results may require aggressive `LIVE_EVIDENCE` reduction under hard overflow, which can reduce the information available to the next model turn and hurt semantic continuity.
- The current reducer still has a measurable hard-overflow “last mile”: real sessions have reached only tens or hundreds of tokens above `safe_input` after reclaiming tens or hundreds of thousands of tokens.
- Exact LM Studio measurement is validated; other runtimes remain generic/approximate until a provider is implemented and validated.
- The reasoning stream `strip` mode is a compatibility workaround and remains opt-in.

These limitations are tracked as alpha observations. They are not all release blockers for the gateway itself.

## Daily test matrix

Do not use “did the model finish a difficult coding investigation?” as the sole acceptance criterion. That mixes model quality, harness behavior, tool quality, client limits and gateway behavior.

For daily testing, run fixed scenarios and classify results:

1. **Normal tool session** — 5–10 tool rounds without extreme context pressure. Expect exact measurement, preserved streaming/tool calls and `request_after <= safe_input`.
2. **SAFE eviction** — accumulate large historical tool outputs. Expect old tool results to shrink without `LIVE_EVIDENCE` eviction.
3. **Hard overflow** — create a request well above the loaded context. Both `forwarded` after a verified safe reduction and local `context_budget_exceeded` are valid outcomes. An oversized upstream request is not.
4. **Reasoning compatibility** — Thinking enabled upstream with `CONTEXT_REASONING_STREAM=strip`; verify reasoning is observed/stripped while tool calls and terminal SSE semantics survive.

Current adversarial local-model candidates include Qwen3.5 9B, Ornith 1.0 9B MTP, and Ornith 1.0 9B Abliterated/Fable MTP. Model loops or task-quality failures should be classified separately from transport/context-safety failures.

## Alpha release blockers

Treat the following as release blockers:

- any request above authoritative `safe_input` reaches upstream;
- exact measurement silently downgrades mid-request;
- tool-call IDs/order/pairing are corrupted;
- system/developer/latest-user/current protocol structures are incorrectly removed;
- a reduction candidate increases authoritative whole-request tokens;
- SSE/tool-call/content/finish semantics are corrupted by the compatibility transform;
- archived payloads required by the current contract become unrecoverable;
- cancellation, streaming, or required upstream header behavior is corrupted;
- a request that should fail locally is sent oversized to the runtime.

Do **not** block the alpha solely because a model loops, a harness reaches its step limit, or a safe deterministic request is rejected with a structured local `context_budget_exceeded`.

## Beta promotion criteria

Promote from alpha to beta only after 5–7 days of real use without:

- oversized requests reaching upstream;
- protocol corruption;
- silent exact-to-approximate measurement downgrade;
- loss of CAS recoverability;
- streaming or reasoning-compatibility regressions.

Beta readiness measures gateway stability. It does not require zero model loops, task failures, step-limit terminations, or legitimate local `context_budget_exceeded` responses.

## Health check

```bash
curl http://127.0.0.1:18181/health
```

## Scope

The core provides transport preservation, loaded-context discovery, request measurement, hard budgeting, deterministic recoverable reduction, verification, fail-closed errors and metadata-only observability.

It intentionally does not implement agent orchestration, behavioral prompts, semantic summarization, loop supervision, MCP, or runtime-specific workflow policy.

See [`PLAN.md`](PLAN.md) for architecture and roadmap details and [`VALIDATION.md`](VALIDATION.md) for current real-world observations.

## Public alpha note

The repository can be made public while `package.json` remains `"private": true`; that flag prevents accidental npm publication and does not control GitHub repository visibility. Keep it until npm publication is explicitly intended.

## License

Licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
