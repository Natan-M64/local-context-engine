import type { ChatCompletionRequest } from "../../types/openai.js"
import type { TokenMeasurementProvider } from "./provider.js"

export class GenericConservativeProvider implements TokenMeasurementProvider {
  constructor(private readonly estimate: (request: ChatCompletionRequest) => number) {}

  async estimateChatRequest(request: ChatCompletionRequest): Promise<number> {
    return this.estimate(request)
  }
}

export type TokenMeasurementCapability = "lmstudio" | "ollama" | "omlx" | "llamacpp" | "generic"

export interface TokenMeasurementProviderFactory {
  capability: TokenMeasurementCapability
  create(): TokenMeasurementProvider
}

export class CapabilityTokenMeasurementProvider implements TokenMeasurementProvider {
  constructor(
    private readonly providers: readonly TokenMeasurementProviderFactory[],
    private readonly fallback: TokenMeasurementProvider,
  ) {}

  async estimateChatRequest(request: ChatCompletionRequest): Promise<number> {
    for (const factory of this.providers) {
      try {
        const estimate = await factory.create().estimateChatRequest(request)
        if (estimate !== undefined && Number.isFinite(estimate) && estimate >= 0) return estimate
      } catch {
        continue
      }
    }
    return this.fallback.estimateChatRequest(request).then((estimate) => {
      if (estimate === undefined || !Number.isFinite(estimate) || estimate < 0) throw new RangeError("generic token provider returned an invalid estimate")
      return estimate
    })
  }
}

export function createTokenMeasurementProvider(
  factories: readonly TokenMeasurementProviderFactory[],
  fallback: TokenMeasurementProvider,
): TokenMeasurementProvider {
  return new CapabilityTokenMeasurementProvider(factories, fallback)
}

export class OllamaTokenProvider implements TokenMeasurementProvider {
  async estimateChatRequest(_request: ChatCompletionRequest): Promise<number | undefined> {
    return undefined
  }
}

export class OmlxTokenProvider implements TokenMeasurementProvider {
  async estimateChatRequest(_request: ChatCompletionRequest): Promise<number | undefined> {
    return undefined
  }
}

export class LlamaCppTokenProvider implements TokenMeasurementProvider {
  async estimateChatRequest(_request: ChatCompletionRequest): Promise<number | undefined> {
    return undefined
  }
}

export { LMStudioTokenProvider } from "./lmstudio.js"
export type { LMStudioTokenProviderOptions } from "./lmstudio.js"
export type { TokenMeasurementProvider as TokenMeasurementProviderInterface } from "./provider.js"
