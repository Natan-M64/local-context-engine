import assert from "node:assert/strict"
import test from "node:test"
import {
  CapabilityTokenMeasurementProvider,
  GenericConservativeProvider,
  LlamaCppTokenProvider,
  OllamaTokenProvider,
  OmlxTokenProvider,
  type TokenMeasurementProviderFactory,
} from "../src/context/providers/index.js"
import type { TokenMeasurementProvider } from "../src/context/providers/provider.js"
import type { ChatCompletionRequest } from "../src/types/openai.js"

const sampleRequest: ChatCompletionRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
}

class StaticProvider implements TokenMeasurementProvider {
  constructor(private readonly value: number | undefined) {}

  async estimateChatRequest(_request: ChatCompletionRequest): Promise<number | undefined> {
    return this.value
  }
}

class ThrowingProvider implements TokenMeasurementProvider {
  async estimateChatRequest(_request: ChatCompletionRequest): Promise<number | undefined> {
    throw new Error("provider error")
  }
}

test("returns first valid estimate from capability providers", async () => {
  const provider = new CapabilityTokenMeasurementProvider(
    [
      { capability: "lmstudio", create: () => new StaticProvider(undefined) },
      { capability: "ollama", create: () => new StaticProvider(42) },
    ],
    new GenericConservativeProvider(() => 100),
  )

  const estimate = await provider.estimateChatRequest(sampleRequest)
  assert.equal(estimate, 42)
})

test("falls back to generic conservative provider when specific providers throw or return undefined", async () => {
  const provider = new CapabilityTokenMeasurementProvider(
    [
      { capability: "lmstudio", create: () => new ThrowingProvider() },
      { capability: "ollama", create: () => new StaticProvider(undefined) },
      { capability: "omlx", create: () => new StaticProvider(-5) },
    ],
    new GenericConservativeProvider(() => 100),
  )

  const estimate = await provider.estimateChatRequest(sampleRequest)
  assert.equal(estimate, 100)
})

test("stub providers return undefined by default", async () => {
  assert.equal(await new OllamaTokenProvider().estimateChatRequest(sampleRequest), undefined)
  assert.equal(await new OmlxTokenProvider().estimateChatRequest(sampleRequest), undefined)
  assert.equal(await new LlamaCppTokenProvider().estimateChatRequest(sampleRequest), undefined)
})
