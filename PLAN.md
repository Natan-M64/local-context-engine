# Local Context Engine Plan

## Objective

Make agentic workflows usable on constrained-context local LLMs without requiring the agent harness or inference runtime to be designed for small models.

The product is a transparent, universal context runtime. It protects a physically loaded model context from oversized OpenAI-compatible chat requests, especially requests inflated by accumulated tool outputs.

## Problem

A session can begin near 10K tokens, execute several large reads in parallel, then produce a 40–45K-token follow-up request against a runtime loaded with roughly 25K tokens. The runtime rejects the request before ordinary harness compaction can help.

Prompt instructions are not enforcement. Harness context settings do not necessarily constrain one accumulated tool round. Sending an oversized request and expecting provider truncation is unacceptable.

## Product boundaries

### Core responsibilities

- OpenAI-compatible HTTP gateway and passthrough;
- loaded runtime/model context discovery;
- conservative token accounting;
- hard input/output/safety budgets;
- deterministic tool-output reduction;
- content-addressed storage for evicted output;
- post-reduction verification and fail-closed behavior;
- metrics needed to prove enforcement;
- watermark and hysteresis policy after the basic path is proven.

### Outside the core

- agent workflow orchestration;
- anti-hallucination policy;
- repository evidence contracts;
- Kilo/OpenCode-specific modes or markers;
- mandatory launcher or permanent harness fork;
- mandatory MCP integration;
- semantic summarization in the first release;
- retrieval/indexing unrelated to archived context.

## Architecture

```text
Kilo / OpenCode / Aider / any OpenAI-compatible client
                         │
                         ▼
              local-context-engine
      ┌─────────────────────────────────┐
      │ OpenAI transport and streaming  │
      │ Runtime discovery               │
      │ Token measurement               │
      │ Context governor                │
      │ Tool-result eviction            │
      │ Content-addressed store         │
      │ Verification and metrics        │
      └────────────────┬────────────────┘
                       │ safe request only
                       ▼
       LM Studio / oMLX / Ollama / llama.cpp / vLLM
```

The gateway does not need to know which agent generated the request. Runtime-specific behavior belongs behind small adapters or capability probes.

## Non-negotiable invariants

1. Never forward a request above the computed safe input budget.
2. Never rely on the LLM to obey output-size instructions.
3. Never rely on the upstream runtime to truncate safely.
4. Preserve the system prompt, latest user request, current turn protocol continuity, and output reserve.
5. Prefer deterministic eviction over semantic compaction.
6. Verify the complete transformed request immediately before forwarding.
7. Fail locally and structurally when safe reduction is impossible.
8. Keep archived content recoverable by a stable content hash.
9. Do not penalize large-context models with unnecessary aggressive reduction.
10. Do not require a custom launcher, harness fork, runtime fork, GPU, or operating system.

## Context budget

For each request:

```text
advertised_context = theoretical or catalog model limit; informational only
loaded_context     = context physically loaded by the runtime, when discoverable
configured_context = explicit conservative fallback
effective_context  = loaded_context, otherwise configured_context, otherwise unavailable
output_reserve     = requested output limit or configured default
safety_reserve     = configured estimation uncertainty reserve or conservative margin
safe_input         = effective_context - output_reserve - safety_reserve
```

Example:

```text
loaded_context  = 25,088
effective_context = 25,088
output_reserve  = 4,096
safety_reserve  = 2,000
safe_input      = 18,992
```

The final estimate includes messages and tool definitions. An advertised or theoretical model limit never establishes the effective context. If the loaded context cannot be discovered and no explicit context is configured, the engine must fail closed rather than guess a permissive value.

## Token estimation

Token accounting is exposed through a replaceable `TokenMeasurementProvider` interface with explicit confidence levels (`exact` or `approximate`).

In `CONTEXT_TOKEN_ESTIMATOR=auto` mode, when an exact provider such as `LMStudioTokenProvider` is active, its measurement is authoritative for Measure, Budget, Evict (Fits), and Verify steps for that request. If exact measurement becomes unavailable during the same request, the gateway fails closed with `token_measurement_unavailable`; it does not downgrade to approximate. When no exact provider is selected or when set to `static`, the gateway uses `GenericConservativeProvider` (character-based estimation) as an approximate best-effort measurement. In `shadow` mode, exact measurements are recorded in metrics while budgeting decisions use static character estimates. The category breakdown remains heuristic and approximate.

## Deterministic reduction policy

Reduction is the generic operation. Deterministic strategies may include eviction, deduplication, trimming, and archival, introduced only in their roadmap phases. v0.1 uses eviction and archival. Semantic compaction is a distinct, optional future strategy and must not introduce extra LLM calls in v0.1 or v0.2.

Initial priority:

1. old large tool results;
2. repeated tool results;
3. old raw file bodies;
4. old search and listing output;
5. old build, test, diff, and log output;
6. only in a later phase, old conversational history.

Must preserve:

- system instructions;
- latest real user request;
- current turn messages;
- tool-call/tool-result structure required by the protocol;
- tool-call IDs, message order, and pairing between assistant calls and tool results;
- recent relevant evidence where possible.

Reduction may replace a tool result's content, but it must not remove only one side of a required pair, change its ID, or reorder the protocol sequence.

Reduction classes are:

- **SAFE:** old tool results and already archived deterministic payloads; eligible for automatic eviction;
- **LIVE_EVIDENCE:** current or recently produced tool results required for continuity; excluded from preventive reduction and eligible for bounded CAS externalization only under hard overflow after SAFE is exhausted;
- **CAUTIOUS:** old assistant narrative and progress; excluded from preventive and hard-overflow reduction in the current policy;
- **PROTECTED:** system/developer messages, all user requirements, tool names, schemas and descriptions, current tool-call arguments, and protocol identifiers; never reduced automatically.

`targetTokens` is a best-effort optimization objective applied only to SAFE content. `safeInput` is the hard forwarding boundary. Requests at or below `safeInput` pass through without LIVE_EVIDENCE reduction. Above `safeInput`, reduction proceeds through SAFE and then LIVE_EVIDENCE; existing CAUTIOUS policy may follow only if required. If those classes cannot bring the request within `safeInput`, the gateway fails closed.

An evicted result becomes a bounded replacement:

```text
[Tool output archived]
Handle: ctx://sha256/<hash>
Original size: <bytes> (<estimated tokens> estimated tokens)
Preview:
<bounded head/tail preview>
```

LIVE_EVIDENCE uses a distinct hard-overflow representation whose head/tail excerpt is allocated dynamically from the remaining `safeInput` budget, newest evidence first:

```text
[Current tool output partially archived]
Handle: ctx://sha256/<hash>
Original estimated tokens: <n>
Preserved estimated tokens: <n>

--- BEGIN EXCERPT ---
<bounded 50% head / 50% tail excerpt>
--- END EXCERPT ---
```

The full body is stored in a filesystem content-addressed store. Identical content deduplicates naturally. The stable handle is independent of the storage and retrieval implementation.

Stored objects must carry minimal lifecycle metadata: content hash, creation time, last-access time, byte size, and content type. Future bounded retention may add maximum size, TTL, LRU eviction, and manual pruning without changing handles. SQLite and richer indexing remain outside the initial release.

## Fail-closed contract

If deterministic eviction cannot reduce the request to the safe budget, return locally without contacting the runtime:

```json
{
  "error": {
    "type": "context_budget_exceeded",
    "loaded_context": 25088,
    "configured_context": null,
    "effective_context": 25088,
    "context_source": "loaded",
    "safe_input": 18992,
    "request_tokens": 26031,
    "reclaimed_tokens": 12200
  }
}
```

No oversized retry is allowed.

## Runtime discovery

Discovery must prefer the context physically loaded by the runtime over a theoretical model maximum.

Planned adapters/probes:

- LM Studio native model metadata and OpenAI-compatible `/v1/models`;
- oMLX model metadata;
- Ollama native model/show metadata and OpenAI-compatible endpoints;
- llama.cpp server metadata where implemented;
- vLLM model metadata;
- generic OpenAI-compatible fallback;
- explicit `CONTEXT_WINDOW_TOKENS` configuration.

Capabilities must be based on observed implemented APIs. Unknown fields or endpoints cannot be invented.

## Profiles

Profiles tune policy; they do not change hard enforcement:

- **constrained:** effective context up to 32K; strict reserves and aggressive deterministic eviction;
- **balanced:** effective context above 32K and below 64K; larger evidence allowance with the same verification path;
- **large:** effective context of 64K and above; minimal intervention unless the request approaches the actual safe budget.

Thresholds remain provisional until measurements across runtimes justify adjustment.

## Watermarks and anti-thrashing

After the basic overflow path is reliable, add a context governor with hysteresis:

```text
Target     45%
Rearm      65%
High       75%
Emergency  90%
```

All watermark percentages are relative to `safe_input`, never to the physical or effective context. Normal operation below rearm performs no reduction. Crossing high triggers enough eviction to return near target, not merely below high. The governor rearms only after meaningful growth, preventing repeated small reductions.

The governor supports two experiment modes through `CONTEXT_GOVERNOR_MODE`: `protect` disables preventive reduction and applies the same hard-overflow policy strictly above `safeInput`; `govern` enables SAFE-only preventive reduction through watermarks and hysteresis. In either mode, hard overflow reduces SAFE first, then may externalize bounded LIVE_EVIDENCE under the current policy before failing closed.

Additional controls:

- minimum tokens reclaimed;
- minimum growth before another reduction;
- optional minimum turns between reductions when session identity is available;
- session identity priority is explicit conversation/session ID, configured stable header, conservative conversation-prefix fingerprint, then stateless operation; request IDs and model/IP/user tuples are not persistent conversation identity;
- inferred identity may improve hysteresis efficiency but is never required for hard budget enforcement, final verification, or fail-closed correctness;
- no semantic compaction when projected deterministic gain is sufficient;
- emergency reduction still obeys must-preserve rules.

## Current repository state

The repository currently implements:

- strict TypeScript project setup;
- context budget calculation;
- token estimation behind a replaceable interface with explicit confidence (`exact` or `approximate`), including validated exact LM Studio measurement and generic fallback;
- deterministic old-tool-result and historical assistant tool-call argument reduction;
- filesystem SHA-256 content store with stable handles and lifecycle metadata;
- physically loaded runtime context discovery with a fail-closed configured fallback;
- context governor with watermarks, hysteresis, and `protect`/`govern` modes;
- optional streamed reasoning compatibility mode (`CONTEXT_REASONING_STREAM=passthrough|strip`);
- OpenAI-compatible gateway, CLI, and metadata-only JSONL observability;
- comprehensive unit, gateway, streaming, cancellation, and sanitized replay tests.

This `v0.2.0-alpha.1` daily-driver testing release passes typecheck, tests, and production compilation.

## Roadmap

### Phase 0 — Foundation

- [x] Create a clean standalone repository.
- [x] Add strict TypeScript/Node project setup.
- [x] Implement budget calculation and request measurement.
- [x] Define a replaceable token estimator interface.
- [x] Add explicit conservative estimator confidence and account for the complete request payload.
- [x] Implement filesystem content-addressed storage.
- [x] Add minimal CAS lifecycle metadata without changing stable handles.
- [x] Implement deterministic tool-result eviction.
- [x] Complete exports and executable package wiring.
- [x] Validate the entire current tree with typecheck, tests, and build.
- [x] Validate the MVP gateway path with local mock-upstream integration tests.

### v0.1 — Hard overflow prevention

- [x] Complete generic OpenAI-compatible HTTP transport.
- [x] Pass `GET /v1/models` through unchanged.
- [x] Preserve non-streaming responses.
- [x] Preserve SSE streaming byte order and termination.
- [x] Preserve cancellation and safe headers.
- [x] Resolve effective context from the physically loaded context or require explicit configuration.
- [x] Measure messages and tool schemas through the estimator interface.
- [x] Reduce oversized tool-output context deterministically while preserving protocol pairs and IDs.
- [x] Re-measure before forwarding.
- [x] Return `context_budget_exceeded` without upstream contact when reduction is insufficient.
- [x] Emit structured metrics for input, reserves, estimator confidence, safe budget, reclaimed tokens, evictions, and forwarding decision.
- [x] Emit metadata-only token attribution before and after reduction without recording request content.
- [x] Support opt-in metadata-only JSONL metrics from the standalone CLI.

### v0.2.0-alpha.1 — Daily-driver testing (Current)

- [x] Message/output classification without harness-specific names (SAFE, LIVE_EVIDENCE, CAUTIOUS, PROTECTED).
- [x] Watermarks and hysteresis in the context governor (`protect` vs `govern` modes).
- [x] Historical assistant tool-call argument archival under hard overflow.
- [x] Emergency archive marker compaction under narrow hard overflow.
- [x] Exact LM Studio prompt token measurement provider via `@lmstudio/sdk`.
- [x] Optional reasoning stream compatibility mode (`CONTEXT_REASONING_STREAM=passthrough|strip`).
- [x] Fail-closed verification preventing oversized requests from reaching upstream.

### v0.2.0-alpha.2+ Candidates (Deferred)

- [ ] Atomic eviction of fully completed historical tool rounds (`HISTORICAL_TOOL_ROUND`).
- [ ] Richer semantic-viability and retention telemetry for LIVE evidence.
- [ ] Automatic confidence-aware safety reserve selection.
- [ ] Repeated-output deduplication.
- [ ] Additional validated runtime measurement adapters (Ollama, oMLX, llama.cpp, vLLM).

### v0.3 — Retrieval

- [ ] Add optional MCP server.
- [ ] Add `context_get`, `context_slice`, and bounded `context_search`.
- [ ] Keep retrieval results independently budgeted.
- [ ] Add metadata indexing only when filesystem CAS is insufficient.

### Later, optional

- [ ] SQLite/FTS metadata and search.
- [ ] Optional semantic compaction after deterministic strategies.
- [ ] Optional Kilo/OpenCode plugins for richer integration.
- [ ] Observability dashboard and long-run profile tuning.

These features remain outside the core until earlier acceptance criteria are met.

## MVP acceptance criteria

The MVP is ready only when automated integration tests prove:

1. `GET /v1/models` works through the gateway.
2. Ordinary non-streaming and streaming requests are not corrupted.
3. A request around 10K tokens reaches the upstream materially unchanged.
4. A request around 40K tokens for a runtime loaded at 25,088 reaches the upstream at or below the computed safe input budget.
5. If safe reduction is impossible, the upstream receives no request.
6. The known multi-read scenario with large SQL, JSON, and log outputs cannot trigger an upstream context-size overflow.
7. Evicted content is retrievable from its content-addressed handle.
8. `npm run check` and `npm run build` pass.

## Test strategy

### Unit tests

- budget arithmetic and invalid reserves;
- estimator behavior, confidence, replaceability, and safety margin assumptions;
- stable content hashes, lifecycle metadata, and deduplication;
- eviction priority and immutability;
- preservation of required messages, tool-call pairs, IDs, and order;
- fail-closed error shape;
- runtime metadata parsing.

### Integration tests

Use a local mock upstream that records requests and emits controlled JSON/SSE responses. Assert both what the client receives and exactly what the upstream receives.

Golden scenarios:

- below-budget passthrough;
- oversized old tool outputs;
- oversized preserved system/user context;
- tool schemas consuming significant input;
- streaming cancellation;
- runtime discovery unavailable;
- physically loaded context lower than catalog maximum;
- loaded context unavailable with explicit configured fallback;
- loaded and configured contexts unavailable, proving fail-closed behavior;
- SQL + users JSON + groups JSON + tracker log accumulation, asserting the upstream receives at most `safe_input` tokens or no request;
- sanitized replay derived from a Windows/Kilo/LM Studio investigation, preserving recent target evidence while archiving older large outputs.

### Runtime smoke tests

After mock integration is stable, test LM Studio first, then oMLX, Ollama, llama.cpp, and vLLM. Record observed API fields rather than assuming parity.

The first Kilo + LM Studio session demonstrated end-to-end operation with a 25,000-token loaded context, but the exported transcript alone cannot attribute truncation or compaction to this gateway. Runtime validation must capture the opt-in JSONL metrics so each forwarding and eviction decision is independently provable. Environment commands, available tools, skills, and agent behavior remain harness responsibilities and must not be injected by the core.

## Definition of done for a change

A change is complete when:

- it preserves the non-negotiable invariants;
- focused regression tests cover the behavior;
- `npm run check` passes;
- `npm run build` passes;
- no oversized request can bypass the final verification path;
- documentation changes reflect durable behavior only.

## Final direction

The engine is not an agent, prompt collection, safe-tool suite, or harness configuration. It is a small context runtime with one governing philosophy:

```text
Measure → Budget → Evict/Reduce → Verify → Forward
```

After that path is trustworthy:

```text
Store → Retrieve
```
