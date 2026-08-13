import assert from "node:assert/strict"
import test from "node:test"
import { contextWindowFromModels } from "../src/runtime/discovery.js"

test("prefers the loaded runtime context over catalog limits", () => {
  assert.equal(contextWindowFromModels({
    models: [{
      id: "qwen",
      max_context_length: 131_072,
      loaded_instances: [{ id: "qwen", config: { context_length: 25_088 } }],
    }],
  }, "qwen"), 25_088)
})

test("does not treat catalog limits as loaded context", () => {
  assert.equal(contextWindowFromModels({
    data: [{ id: "local", max_model_len: 32_768 }],
  }, "local"), undefined)
})

test("reads a generic loaded context field", () => {
  assert.equal(contextWindowFromModels({
    data: [{ id: "local", loaded_instances: [{ config: { context_length: 32_768 } }] }],
  }, "local"), 32_768)
})
