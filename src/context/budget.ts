export interface ContextBudgetInput {
  effectiveContext?: number
  physicalContext?: number
  outputReserve: number
  safetyReserve: number
}

export interface ContextBudget {
  effectiveContext: number
  physicalContext: number
  outputReserve: number
  safetyReserve: number
  safeInput: number
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
  return Math.floor(value)
}

export function createContextBudget(input: ContextBudgetInput): ContextBudget {
  const contextValue = input.effectiveContext ?? input.physicalContext
  if (contextValue === undefined) throw new RangeError("effectiveContext must be provided")
  const effectiveContext = nonNegativeInteger("effectiveContext", contextValue)
  const outputReserve = nonNegativeInteger("outputReserve", input.outputReserve)
  const safetyReserve = nonNegativeInteger("safetyReserve", input.safetyReserve)
  const safeInput = effectiveContext - outputReserve - safetyReserve
  if (safeInput <= 0) {
    throw new RangeError("output and safety reserves leave no safe input budget")
  }
  return { effectiveContext, physicalContext: effectiveContext, outputReserve, safetyReserve, safeInput }
}
