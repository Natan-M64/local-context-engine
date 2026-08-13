import assert from "node:assert/strict"
import test from "node:test"
import { createContextBudget } from "../src/context/budget.js"

test("computes the safe input budget from physical and reserved tokens", () => {
  assert.deepEqual(
    createContextBudget({ effectiveContext: 25_088, outputReserve: 4_096, safetyReserve: 2_000 }),
    { effectiveContext: 25_088, physicalContext: 25_088, outputReserve: 4_096, safetyReserve: 2_000, safeInput: 18_992 },
  )
})

test("rejects a configuration without input capacity", () => {
  assert.throws(
    () => createContextBudget({ effectiveContext: 4_096, outputReserve: 4_096, safetyReserve: 0 }),
    /leave no safe input budget/,
  )
})
