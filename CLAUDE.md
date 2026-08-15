# Claude Code / Agent Instructions

This file provides direct guidance for AI coding agents (Claude Code, Codex, Kilo, etc.) working on Local Context Engine.

## Mission and Scope

Build a small, universal context gateway for constrained-context local LLMs. Keep the core proxy transparent, runtime-agnostic, and independent of specific agent harnesses, models, GPU vendors, or operating systems.

Do not add to the core:
- agent modes, prompts, or workflow orchestration;
- semantic compaction before deterministic reduction is proven insufficient;
- loop supervision or behavioral model fixes;
- harness-specific markers or forced tools;
- MCP or SQLite before their roadmap phase in `PLAN.md`.

## Core Invariant

Every chat request follows:

```text
Measure → Budget → Evict/Reduce → Verify → Forward
```

- Authoritative whole-request token measurement must be satisfied before forwarding.
- Oversized requests must never reach the upstream inference runtime.
- If deterministic reduction is insufficient to meet the budget, fail closed locally with a structured `context_budget_exceeded` error.
- Preserve tool-call IDs, pairing, message order, caller objects, and stream byte order/SSE semantics.

## Required Development and Validation Workflow

Before completing or proposing any changes, always run:

```bash
npm run check
npm run build
git diff --check
```

`npm run check` runs strict TypeScript typechecking and the complete test suite.

## Testing Discipline

- Add a focused regression test in `test/` for every change to budgeting, reduction, streaming, or transport logic.
- Differentiate gateway transport/budgeting failures from agent behavior/model loops.
- Do not commit secrets, test dumps, transcripts, or private tokens. Keep test fixtures purely synthetic.
