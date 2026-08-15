# Validation Notes

This document records real-world observations used to define the `v0.2.0-alpha.1` daily-driver testing scope. These are not benchmark claims and should not be interpreted as rankings of the models involved.

## Test environment

Representative local runs used:

- Kilo/OpenCode-compatible client path;
- Local Context Engine at `http://127.0.0.1:18181/v1`;
- LM Studio upstream at `http://127.0.0.1:1234/v1`;
- physically loaded context: `25088` tokens;
- client output limit: `4096` tokens in the controlled comparison runs;
- `CONTEXT_TOKEN_ESTIMATOR=auto` with LM Studio exact measurement;
- `CONTEXT_GOVERNOR_MODE=govern`;
- `CONTEXT_REASONING_STREAM=strip` for reasoning-capable compatibility testing.

The real workload was a tool-heavy investigation over large SQL/JSON/source-code inputs. It intentionally produced conditions that stress accumulated tool history and hard-overflow reduction.

## Observations after commit `de37df8`

### Qwen3.5 9B — successful safe reduction, then harness termination

One long request was measured at approximately:

```text
before        111411
safe_input     18944
after          18063
reclaimed      93348
```

The gateway forwarded the reduced request safely. The final stream completed with `[DONE]` and `finish_reason = stop`. The corresponding agent session stopped because the harness reached its maximum step limit, not because the gateway forwarded an oversized request.

Classification: **context safety PASS / task completion WARN**.

### Qwen3.5 9B — extreme history plus large current evidence

A continued session reached approximately:

```text
before        485704
safe_input     18944
after          18880
reclaimed     466824
```

The reducer archived a very large amount of old tool history and also reduced a large current tool result (`LIVE_EVIDENCE`) to a small retained excerpt. The request fit, but the agent was observed repeating broad tool calls and was eventually aborted by the client.

This exposed a semantic-continuity limitation: a request can be structurally safe while aggressive reduction of the current evidence may still leave the next model turn with too little useful information.

Classification: **context safety PASS / semantic continuity EXPERIMENTAL / agent loop separate**.

### Ornith 1.0 9B MTP — hard-overflow last mile with 2048 reserve

Controlled run with `output=4096`:

```text
before         91787
safe_input     18944
after          19095
reclaimed      72692
difference       151
```

The gateway correctly returned local `context_budget_exceeded` and did not forward an oversized request.

Classification: **fail-closed PASS / reducer last-mile observation**.

### Ornith 1.0 9B Abliterated/Fable MTP — hard-overflow last mile with 2048 reserve

Controlled run with `output=4096`:

```text
before        111665
safe_input     18944
after          18962
reclaimed      92703
difference        18
```

Again, the gateway correctly failed locally. This demonstrates that reclaiming almost the entire excess request does not guarantee that the remaining protected/protocol footprint will fit.

Classification: **fail-closed PASS / reducer last-mile observation**.

### Ornith 1.0 9B MTP — exact-measurement daily-test reserve of 512

A subsequent run explicitly set:

```text
output_reserve = 4096
safety_reserve = 512
safe_input     = 20480
```

Observed request:

```text
before         42466
after          20520
reclaimed      21946
difference        40
```

The larger usable input budget helped but did not eliminate the recurring last-mile pattern. The gateway again failed closed correctly.

Conclusion: lowering the safety reserve is useful for the exact LM Studio test profile, but repeatedly reducing the reserve is not a substitute for future reducer improvements.

### Ornith 1.0 9B Abliterated/Fable MTP — behavioral loop

With the 512-token test reserve, another run repeatedly searched for the same backend symbol/method with materially equivalent `grep`/Serena calls after receiving no new evidence. The session did not demonstrate a new gateway transport or budgeting failure; it demonstrated agent/model loop behavior.

Classification: **agent behavior FAIL / gateway not automatically implicated**.

## What these tests establish

The current gateway has repeatedly demonstrated:

- exact LM Studio whole-request measurement;
- very large deterministic reclamation;
- no intentional forwarding above authoritative `safe_input`;
- structured local `context_budget_exceeded` when allowed reduction is insufficient;
- preservation of current/protected protocol structures under the existing policy;
- optional reasoning-stream suppression without requiring model-side Thinking to be disabled.

The tests also exposed two separate non-blocking alpha limitations:

1. **Reducer last mile:** after reclaiming very large histories, the remaining protocol/protected footprint can still be only tens or hundreds of tokens above `safe_input`.
2. **Semantic continuity under LIVE pressure:** keeping a request structurally safe may require reducing the current tool result so heavily that a weak local model repeats an investigation rather than progressing.

Agent-level repeated tool calls are a third observation, but they are outside the core gateway responsibility.

## Alpha interpretation rules

A real test should be classified as a gateway failure only when one of the core invariants is violated, for example:

- an oversized request reaches upstream;
- exact measurement silently downgrades within the same request;
- message/tool protocol structure is corrupted;
- current protected data is reduced contrary to policy;
- a transformation increases authoritative request cost and is still accepted;
- SSE/tool-call termination is corrupted;
- required archived data becomes unrecoverable.

The following are not automatically gateway failures:

- `context_budget_exceeded` after all currently allowed deterministic reductions;
- a model repeating equivalent tool calls;
- a client reaching its maximum step count;
- a model returning an empty/terminal `stop` response;
- poor task-level reasoning or factual mistakes by a tested model.

## Daily test profile

For current LM Studio exact-measurement alpha testing:

```text
physical_context            25088
client output limit          4096
CONTEXT_OUTPUT_RESERVE       4096
CONTEXT_SAFETY_RESERVE        512
CONTEXT_TOKEN_ESTIMATOR      auto
CONTEXT_GOVERNOR_MODE        govern
CONTEXT_REASONING_STREAM     strip (when testing the observed reasoning/tool compatibility issue)
```

The 512-token reserve is intentionally a controlled exact-LM-Studio test profile. It is not a universal default for approximate or unvalidated runtimes.

## Daily test matrix

Use fixed gateway scenarios rather than treating completion of one difficult coding investigation as the sole pass/fail signal.

### 1. Normal tool session

- 5–10 tool rounds;
- no extreme context pressure;
- expect exact measurement, preserved tool calls/SSE and `request_after <= safe_input`.

### 2. SAFE eviction

- accumulate large historical tool outputs;
- expect SAFE reduction without touching LIVE evidence when the request can fit without it.

### 3. Hard overflow

- generate a request well above the loaded context;
- valid outcomes are either verified forwarding at/below `safe_input` or local structured `context_budget_exceeded`;
- forwarding an oversized request is always a failure.

### 4. Reasoning compatibility

With upstream Thinking enabled and `CONTEXT_REASONING_STREAM=strip`, verify at least one tool turn where metrics show reasoning observed/stripped while tool calls and terminal SSE semantics remain intact.

## Current adversarial model set

The following local models have been useful because they stress different failure modes:

- Qwen3.5 9B — baseline tool/coding behavior and large LIVE-output pressure;
- Ornith 1.0 9B MTP — fast tool-heavy stress and hard-overflow last-mile cases;
- Ornith 1.0 9B Abliterated/Fable MTP — aggressive tool/lifecycle and behavioral-loop stress.

Model task quality must be reported separately from gateway transport/context safety.

## Deferred candidates for later alpha iterations

Do not block `v0.2.0-alpha.1` on these unless a new test proves a core invariant is violated:

- atomic eviction of fully completed historical tool rounds;
- richer semantic-viability/retention telemetry for LIVE evidence;
- confidence-aware automatic reserve policy instead of an explicit test-profile reserve;
- additional validated runtime measurement providers;
- loop supervision or behavioral policy (expected to remain outside the core).

The alpha exists so these decisions can be based on actual usage rather than continuing to expand the pre-release scope.
