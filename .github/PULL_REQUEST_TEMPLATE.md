## Summary

<!-- Briefly describe the changes and motivation -->

## Scope and Invariants

- [ ] Keeps core proxy independent from specific agent harnesses or model behavior.
- [ ] Preserves `Measure → Budget → Evict/Reduce → Verify → Forward` fail-closed invariant.
- [ ] Preserves message order, tool-call pairs, and protocol IDs.
- [ ] Conforms to `AGENTS.md` / `CLAUDE.md` guidelines.
- [ ] Includes focused automated tests for changed behavior.
- [ ] Passes `npm run check` and `npm run build`.
- [ ] No secrets, local stores, or private data included.

## Related Issues

<!-- Closes #123 -->
