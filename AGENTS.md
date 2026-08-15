# Agent Instructions

These instructions apply to human contributors and AI coding agents, including Claude Code, Codex, Kilo, and similar tools. When instructions conflict, preserve the narrower repository scope and the core invariants below.

## Mission

Build a small, universal context gateway that makes agentic workflows usable with constrained-context local LLMs. Read `PLAN.md` before architectural or multi-file work.

## Scope

The core is an OpenAI-compatible proxy between any agent harness and any compatible inference runtime. Keep it independent from Kilo, OpenCode, model families, GPU vendors, and operating systems. Do not optimize model behavior; optimize and enforce transport and context constraints.

Do not add to the core:

- agent modes or workflow orchestration;
- behavioral system prompts;
- evidence/provenance contracts;
- forced tools, scouts, capsules, or harness-specific markers;
- semantic compaction before deterministic reduction is proven insufficient;
- MCP or SQLite before their roadmap phase.

## Core invariant

Every chat request follows:

```text
Measure → Budget → Evict/Reduce → Verify → Forward
```

Never forward a request estimated above the authoritative safe input budget. If deterministic reduction cannot make it fit, fail locally with a structured `context_budget_exceeded` error; this is a correct gateway result when allowed safe reduction is insufficient.

Preserve system messages, the latest user request, current protocol continuity, and recent relevant tool results. Evict large, old deterministic tool outputs first. Store evicted content by hash and retain a bounded preview plus a stable handle.

Alpha release blockers are core transport, measurement, protocol, recoverability, and fail-closed invariants—not task completion or model quality. Agent/model tool loops, harness step limits, and poor task outcomes are outside the gateway core. New reduction strategies require reproducible evidence of an invariant violation and a focused regression test; do not turn every model failure into a reducer feature.

## Engineering rules

- Use Node.js 22+, TypeScript ESM, strict types, and built-in Node APIs where practical.
- Keep modules small and policy-neutral. Prefer pure functions for measurement, budgeting, classification, and reduction.
- Resolve the effective context from the runtime-loaded context first, then explicit configuration. Never use an advertised or theoretical model maximum as a permissive fallback.
- Keep token estimation behind a replaceable `TokenMeasurementProvider` interface with explicit confidence (`exact` or `approximate`). When an exact provider is available, its measurement is authoritative; non-exact approximation uncertainty belongs in the estimation uncertainty reserve.
- Preserve tool-call/tool-result pairing, IDs, message order, and required protocol structure during reduction.
- Preserve OpenAI-compatible request/response semantics, headers, cancellation, errors, and SSE byte order.
- Do not mutate caller-owned request objects.
- Avoid dependencies unless they provide clear correctness or interoperability value.
- Do not commit generated `dist/`, local stores, secrets, or `.serena/` metadata.

## Validation

Before completing implementation work, run:

```bash
npm run check
npm run build
```

Add focused regression tests for changed behavior. Gateway changes must cover passthrough, streaming, fail-closed enforcement, and confirmation that oversized requests never reach the upstream.

## Change discipline

Keep changes aligned with the current phase in `PLAN.md`. Do not pull later-stage features into the MVP opportunistically. Update `PLAN.md` only for durable architectural decisions, milestones, or acceptance criteria—not implementation trivia.
