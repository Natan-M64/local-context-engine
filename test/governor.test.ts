import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createContextBudget } from "../src/context/budget.js"
import { MultiSessionGovernor, createGovernorState, evaluateGovernor, updateGovernorAfterReduction } from "../src/context/governor.js"

const budget = createContextBudget({ effectiveContext: 10_000, outputReserve: 1_000, safetyReserve: 1_000 })
// safeInput = 8,000.
// target (45%) = 3600
// rearm (65%) = 5200
// high (75%) = 6000
// emergency (90%) = 7200

test("does not trigger reduction when below high watermark", () => {
  const state = createGovernorState()
  const goal = evaluateGovernor(5_000, budget, state)
  assert.equal(goal.shouldReduce, false)
})

test("triggers reduction when crossing high watermark and disarms until rearmed by growth", () => {
  const state = createGovernorState()
  const goal1 = evaluateGovernor(6_200, budget, state)
  assert.equal(goal1.shouldReduce, true)
  assert.equal(goal1.isEmergency, false)
  assert.equal(goal1.targetTokens, 3_600)

  updateGovernorAfterReduction(state, 6_200, 3_600)
  assert.equal(state.armed, false)

  // Subsequent request at 5,800 should NOT trigger reduction because governor is disarmed (anti-thrashing hysteresis)
  const goal2 = evaluateGovernor(5_800, budget, state)
  assert.equal(goal2.shouldReduce, false)

  // Re-arms when growing past rearm threshold with sufficient growth
  const goal3 = evaluateGovernor(5_900, budget, state)
  assert.equal(goal3.shouldReduce, false)
  assert.equal(state.armed, true)
})

test("triggers emergency reduction when crossing emergency watermark regardless of state", () => {
  const state = createGovernorState()
  state.armed = false
  const goal = evaluateGovernor(8_500, budget, state)
  assert.equal(goal.shouldReduce, true)
  assert.equal(goal.isEmergency, true)
})

test("LRU removes the oldest inactive session without affecting active sessions", async () => {
  const governor = new MultiSessionGovernor(undefined, 2)
  governor.getOrCreateState("old")
  const active = governor.runExclusive("active", 6_200, budget, async ({ updateAfterReduction }) => {
    await delay(20)
    updateAfterReduction(6_200, 3_600)
  })
  await delay(1)
  governor.getOrCreateState("new")
  await active

  assert.equal(governor.hasSession("old"), false)
  assert.equal(governor.hasSession("active"), true)
  assert.equal(governor.hasSession("new"), true)
  assert.equal(governor.getOrCreateState("active").armed, false)
})

test("serializes concurrent requests for one session without corrupting state", async () => {
  const governor = new MultiSessionGovernor()
  const observed: Array<{ armedBefore: boolean; shouldReduce: boolean }> = []

  const first = governor.runExclusive("same-session", 6_200, budget, async ({ goal, armedBefore, updateAfterReduction }) => {
    observed.push({ armedBefore, shouldReduce: goal.shouldReduce })
    await delay(20)
    updateAfterReduction(6_200, 3_600)
  })
  const second = governor.runExclusive("same-session", 5_800, budget, async ({ goal, armedBefore }) => {
    observed.push({ armedBefore, shouldReduce: goal.shouldReduce })
  })

  await Promise.all([first, second])
  assert.deepEqual(observed, [
    { armedBefore: true, shouldReduce: true },
    { armedBefore: false, shouldReduce: false },
  ])
  assert.deepEqual(governor.getOrCreateState("same-session"), { armed: true, lastReducedTokens: 3_600 })
})
