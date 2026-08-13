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
safety_reserve     = configured reserve or conservative estimator margin
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

Token accounting is exposed through a replaceable estimator interface rather than embedded in budgeting or reduction policy. Each estimate reports an explicit confidence level: `exact`, `conservative`, or `approximate`.

The initial conservative character-based estimator is acceptable for v0.1. Model-specific tokenizers or runtime tokenization endpoints may be added later without changing the governor. Any approximation uncertainty must be absorbed by the safety reserve.

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

An evicted result becomes a bounded replacement:

```text
[Tool output archived]
Handle: ctx://sha256/<hash>
Original size: <bytes> (<estimated tokens> estimated tokens)
Preview:
<bounded head/tail preview>
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

Additional controls:

- minimum tokens reclaimed;
- minimum growth before another reduction;
- optional minimum turns between reductions when session identity is available;
- no semantic compaction when projected deterministic gain is sufficient;
- emergency reduction still obeys must-preserve rules.

## Current repository state

The initial implementation contains:

- strict TypeScript project setup;
- context budget calculation;
- conservative character-based token estimation behind a replaceable interface with explicit confidence;
- deterministic old-tool-result eviction that retains message structure and IDs;
- filesystem SHA-256 content store with stable handles and lifecycle metadata;
- physically loaded runtime context discovery with a fail-closed configured fallback;
- OpenAI-compatible gateway, CLI, and metadata-only JSONL observability;
- focused unit, gateway, streaming, cancellation, and sanitized replay tests.

This early v0.1 implementation passes typecheck, tests, and production compilation. Cross-runtime integration validation remains in progress.

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
- [x] Support opt-in metadata-only JSONL metrics from the standalone CLI.

### v0.2 — Context governor

- [ ] Add message/output classification without harness-specific names.
- [ ] Add watermarks and hysteresis.
- [ ] Add repeated-output deduplication.
- [ ] Add per-tool and per-turn evidence budgets.
- [ ] Add policies for code, logs, JSON, SQL, diffs, builds, tests, and listings.
- [ ] Add runtime/profile-specific conservative defaults.

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
Measure → Budget → Evict → Verify → Forward
```

After that path is trustworthy:

```text
Store → Retrieve
```
