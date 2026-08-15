# Contributing to Local Context Engine

Contributions that improve protocol correctness, runtime interoperability, and test coverage are welcome.

## Guidelines

- Keep the core proxy independent from specific agent harnesses, models, GPU vendors, and operating systems.
- Report issues with reproducible steps, including the exact runtime version, client/harness, model name, loaded context size, and anonymized request metrics.
- Provide focused regression tests for any change to budgeting, reduction, streaming, or transport logic.
- Avoid introducing semantic compaction, behavioral prompts, or agent supervision into the core gateway.
- Do not commit secrets, private tokens, benchmark dumps, or local storage artifacts.

## Agent-assisted contributions (Claude Code, Codex, etc.)

We welcome contributions developed with AI coding agents. If you are using an agent:

- Ensure the agent reads and obeys `AGENTS.md`.
- Keep changes scoped to the current phase in `PLAN.md`.
- Ensure all pull requests include focused regression tests and pass `npm run check && npm run build`.
- Review the diff carefully to ensure no auto-generated debugging artifacts, transcripts, or private tokens are included.

## Development workflow

```bash
npm install
npm run check
npm run build
```

Verify that all tests pass and that `git diff --check` reports no whitespace issues before submitting a pull request.
