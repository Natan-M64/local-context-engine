import assert from "node:assert/strict"
import test from "node:test"
import {
  CapabilityTokenMeasurementProvider,
  GenericConservativeProvider,
} from "../src/context/providers/index.js"
import type { TokenMeasurement, TokenMeasurementProvider } from "../src/context/providers/provider.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

const sampleRequest: ChatCompletionRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
}

class StaticProvider implements TokenMeasurementProvider {
  constructor(private readonly value: TokenMeasurement | undefined) {}

  async estimateChatRequest(_request: ChatCompletionRequest): Promise<TokenMeasurement | undefined> {
    return this.value
  }
}

class ThrowingProvider implements TokenMeasurementProvider {
  async estimateChatRequest(_request: ChatCompletionRequest): Promise<TokenMeasurement | undefined> {
    throw new Error("provider error")
  }
}

test("returns first valid estimate from capability providers", async () => {
  const provider = new CapabilityTokenMeasurementProvider(
    [
      { capability: "lmstudio", create: () => new StaticProvider(undefined) },
      { capability: "exact_stub", create: () => new StaticProvider({ tokens: 42, source: "test", confidence: "exact" }) },
    ],
    new GenericConservativeProvider(() => 100),
  )

  const measurement = await provider.estimateChatRequest(sampleRequest)
  assert.equal(measurement.tokens, 42)
  assert.equal(measurement.source, "test")
  assert.equal(measurement.confidence, "exact")
})

test("falls back to generic conservative provider when specific providers throw or return undefined", async () => {
  const provider = new CapabilityTokenMeasurementProvider(
    [
      { capability: "lmstudio", create: () => new ThrowingProvider() },
      { capability: "stub1", create: () => new StaticProvider(undefined) },
      { capability: "stub2", create: () => new StaticProvider({ tokens: -5, source: "bad", confidence: "exact" }) },
    ],
    new GenericConservativeProvider(() => 100),
  )

  const measurement = await provider.estimateChatRequest(sampleRequest)
  assert.equal(measurement.tokens, 100)
  assert.equal(measurement.source, "generic_character")
  assert.equal(measurement.confidence, "approximate")
})
