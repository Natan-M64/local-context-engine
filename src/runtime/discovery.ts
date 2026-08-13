export interface RuntimeContext {
  effectiveContext: number
  source: "loaded"
}

interface RuntimeModel {
  id?: string
  key?: string
  loaded_instances?: Array<{
    id?: string
    config?: { context_length?: number }
  }>
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

export function loadedContextFromModels(payload: unknown, modelId?: string): number | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const container = payload as { data?: RuntimeModel[]; models?: RuntimeModel[] }
  const models = Array.isArray(container.models) ? container.models : container.data
  if (!Array.isArray(models)) return undefined

  const loaded = models.flatMap((model) =>
    (model.loaded_instances ?? []).map((instance) => ({ model, instance })),
  )
  const selected = loaded.find(({ model, instance }) =>
    model.id === modelId || model.key === modelId || instance.id === modelId,
  ) ?? (loaded.length === 1 ? loaded[0] : undefined)
  if (!selected) return undefined
  return positiveInteger(selected.instance.config?.context_length)
}

export function contextWindowFromModels(payload: unknown, modelId?: string): number | undefined {
  return loadedContextFromModels(payload, modelId)
}

export interface RuntimeAdapter {
  discover(upstreamBaseUrl: string, modelId?: string): Promise<RuntimeContext | undefined>
}

export class GenericOpenAIAdapter implements RuntimeAdapter {
  async discover(upstreamBaseUrl: string, modelId?: string): Promise<RuntimeContext | undefined> {
    const endpoint = new URL("/v1/models", upstreamBaseUrl)
    endpoint.search = ""
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return undefined
      const loadedContext = loadedContextFromModels(await response.json(), modelId)
      return loadedContext === undefined ? undefined : { effectiveContext: loadedContext, source: "loaded" }
    } catch {
      return undefined
    }
  }
}

export class LMStudioAdapter implements RuntimeAdapter {
  async discover(upstreamBaseUrl: string, modelId?: string): Promise<RuntimeContext | undefined> {
    const endpoints = [new URL("/api/v1/models", upstreamBaseUrl), new URL("/v1/models", upstreamBaseUrl)]
    for (const endpoint of endpoints) {
      endpoint.search = ""
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) })
        if (!response.ok) continue
        const loadedContext = loadedContextFromModels(await response.json(), modelId)
        if (loadedContext !== undefined) return { effectiveContext: loadedContext, source: "loaded" }
      } catch {
        continue
      }
    }
    return undefined
  }
}

export async function discoverRuntimeContext(
  upstreamBaseUrl: string,
  modelId?: string,
  adapters: RuntimeAdapter[] = [new LMStudioAdapter(), new GenericOpenAIAdapter()],
): Promise<RuntimeContext | undefined> {
  for (const adapter of adapters) {
    const context = await adapter.discover(upstreamBaseUrl, modelId)
    if (context) return context
  }
  return undefined
}

export async function discoverContextWindow(
  upstreamBaseUrl: string,
  modelId?: string,
): Promise<number | undefined> {
  return (await discoverRuntimeContext(upstreamBaseUrl, modelId))?.effectiveContext
}
