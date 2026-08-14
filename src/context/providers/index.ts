import type { ChatCompletionRequest } from "../../types/openai.js"
import type { TokenMeasurement, TokenMeasurementProvider } from "./provider.js"

export class GenericConservativeProvider implements TokenMeasurementProvider {
  constructor(private readonly estimate: (request: ChatCompletionRequest) => number) {}

  async estimateChatRequest(request: ChatCompletionRequest): Promise<TokenMeasurement> {
    const tokens = this.estimate(request)
    return {
      tokens,
      source: "generic_character",
      confidence: "approximate",
    }
  }
}

export interface TokenMeasurementProviderFactory {
  capability: string
  create(): TokenMeasurementProvider
}

export class CapabilityTokenMeasurementProvider implements TokenMeasurementProvider {
  constructor(
    private readonly providers: readonly TokenMeasurementProviderFactory[],
    private readonly fallback: TokenMeasurementProvider,
  ) {}

  async estimateChatRequest(request: ChatCompletionRequest): Promise<TokenMeasurement> {
    for (const factory of this.providers) {
      try {
        const measurement = await factory.create().estimateChatRequest(request)
        if (
          measurement !== undefined &&
          Number.isFinite(measurement.tokens) &&
          measurement.tokens >= 0
        ) {
          return measurement
        }
      } catch {
        continue
      }
    }
    const fallbackMeasurement = await this.fallback.estimateChatRequest(request)
    if (
      fallbackMeasurement === undefined ||
      !Number.isFinite(fallbackMeasurement.tokens) ||
      fallbackMeasurement.tokens < 0
    ) {
      throw new RangeError("generic token provider returned an invalid estimate")
    }
    return fallbackMeasurement
  }
}

export function createTokenMeasurementProvider(
  factories: readonly TokenMeasurementProviderFactory[],
  fallback: TokenMeasurementProvider,
): TokenMeasurementProvider {
  return new CapabilityTokenMeasurementProvider(factories, fallback)
}

export { LMStudioTokenProvider } from "./lmstudio.js"
export type { LMStudioTokenProviderOptions } from "./lmstudio.js"
export type { TokenMeasurement, TokenMeasurementProvider } from "./provider.js"
