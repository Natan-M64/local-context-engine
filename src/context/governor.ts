import type { ContextBudget } from "./budget.js"

export interface WatermarkConfig {
  targetPercent: number
  rearmPercent: number
  highPercent: number
  emergencyPercent: number
  minReclaimedTokens: number
  minGrowthTokens: number
}

export const DEFAULT_WATERMARKS: WatermarkConfig = {
  targetPercent: 0.45,
  rearmPercent: 0.65,
  highPercent: 0.75,
  emergencyPercent: 0.90,
  minReclaimedTokens: 250,
  minGrowthTokens: 500,
}

export interface GovernorState {
  armed: boolean
  lastReducedTokens?: number
}

export interface ReductionGoal {
  shouldReduce: boolean
  targetTokens: number
  isEmergency: boolean
}

export function createGovernorState(): GovernorState {
  return { armed: true }
}

interface SessionEntry {
  state: GovernorState
  lastAccessed: number
  activeOperations: number
  operationTail: Promise<void>
}

export interface GovernorEvaluation {
  goal: ReductionGoal
  armedBefore: boolean
  updateAfterReduction: (beforeTokens: number, afterTokens: number) => void
}

export class MultiSessionGovernor {
  private readonly sessions = new Map<string, SessionEntry>()
  private accessSequence = 0

  constructor(
    private readonly config: WatermarkConfig = DEFAULT_WATERMARKS,
    private readonly maxSessions = 1_000,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions <= 0) throw new RangeError("maxSessions must be a positive integer")
  }

  public getOrCreateState(sessionKey: string): GovernorState {
    return this.getOrCreateEntry(sessionKey).state
  }

  public hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey)
  }

  public evaluate(
    sessionKey: string,
    currentTokens: number,
    budget: ContextBudget,
  ): ReductionGoal {
    const state = this.getOrCreateState(sessionKey)
    return evaluateGovernor(currentTokens, budget, state, this.config)
  }

  public updateAfterReduction(
    sessionKey: string,
    beforeTokens: number,
    afterTokens: number,
  ): void {
    const state = this.getOrCreateState(sessionKey)
    updateGovernorAfterReduction(state, beforeTokens, afterTokens, this.config)
  }

  public async runExclusive<T>(
    sessionKey: string,
    currentTokens: number,
    budget: ContextBudget,
    operation: (evaluation: GovernorEvaluation) => Promise<T>,
  ): Promise<T> {
    const entry = this.getOrCreateEntry(sessionKey)
    entry.activeOperations += 1
    const previous = entry.operationTail
    let release: (() => void) | undefined
    entry.operationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    this.touch(entry)
    const armedBefore = entry.state.armed
    const goal = evaluateGovernor(currentTokens, budget, entry.state, this.config)
    try {
      return await operation({
        goal,
        armedBefore,
        updateAfterReduction: (beforeTokens, afterTokens) => {
          updateGovernorAfterReduction(entry.state, beforeTokens, afterTokens, this.config)
        },
      })
    } finally {
      entry.activeOperations -= 1
      this.touch(entry)
      release?.()
      this.evictIfNeeded()
    }
  }

  private getOrCreateEntry(sessionKey: string): SessionEntry {
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      this.touch(existing)
      return existing
    }

    this.evictIfNeeded(true)
    const entry: SessionEntry = {
      state: createGovernorState(),
      lastAccessed: 0,
      activeOperations: 0,
      operationTail: Promise.resolve(),
    }
    this.touch(entry)
    this.sessions.set(sessionKey, entry)
    return entry
  }

  private touch(entry: SessionEntry): void {
    this.accessSequence += 1
    entry.lastAccessed = this.accessSequence
  }

  private evictIfNeeded(reserveSlot = false): void {
    const limit = reserveSlot ? this.maxSessions - 1 : this.maxSessions
    while (this.sessions.size > limit) {
      let oldestKey: string | undefined
      let oldestAccess = Infinity
      for (const [key, entry] of this.sessions) {
        if (entry.activeOperations === 0 && entry.lastAccessed < oldestAccess) {
          oldestKey = key
          oldestAccess = entry.lastAccessed
        }
      }
      if (oldestKey === undefined) return
      this.sessions.delete(oldestKey)
    }
  }
}

export function evaluateGovernor(
  currentTokens: number,
  budget: ContextBudget,
  state: GovernorState,
  config: WatermarkConfig = DEFAULT_WATERMARKS,
): ReductionGoal {
  const safeInput = budget.safeInput
  const targetTokens = Math.floor(safeInput * config.targetPercent)
  const rearmTokens = Math.floor(safeInput * config.rearmPercent)
  const highTokens = Math.floor(safeInput * config.highPercent)
  const emergencyTokens = Math.floor(safeInput * config.emergencyPercent)

  if (currentTokens > safeInput) {
    state.armed = true
    state.lastReducedTokens = currentTokens
    return { shouldReduce: true, targetTokens, isEmergency: true }
  }

  if (!state.armed) {
    if (state.lastReducedTokens !== undefined) {
      const growth = currentTokens - state.lastReducedTokens
      if (currentTokens >= rearmTokens && growth >= config.minGrowthTokens) {
        state.armed = true
      }
    } else if (currentTokens >= rearmTokens) {
      state.armed = true
    }
  }

  if (currentTokens >= highTokens && state.armed) {
    const isEmergency = currentTokens >= emergencyTokens
    return { shouldReduce: true, targetTokens, isEmergency }
  }

  return { shouldReduce: false, targetTokens, isEmergency: false }
}

export function updateGovernorAfterReduction(
  state: GovernorState,
  beforeTokens: number,
  afterTokens: number,
  config: WatermarkConfig = DEFAULT_WATERMARKS,
): void {
  if (beforeTokens - afterTokens >= config.minReclaimedTokens) {
    state.armed = false
    state.lastReducedTokens = afterTokens
  }
}
