export type ItemStatus = 'pending' | 'in_progress' | 'completed'

/** One step of a plan: a todo item, a task, or a step the progress tool listed. */
export type Item = {
  id: string
  title: string
  /** The todo's present-tense form ("Running tests"), shown while it runs. */
  active?: string
  status: ItemStatus
}

/** The main agent's bar: one task, from the prompt that started it to Done. */
export type Bar = {
  title: string
  items: Item[]
  /** What the progress tool says is happening now. */
  note?: string
  /** The main turn ended; the bar waits for subagents still running. */
  isTurnOver: boolean
  isFinished: boolean
  startedAt: number
  endedAt?: number
  steps: number
  tokens: number
  costUsd: number
  model: string
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  /** The Workflow run that started it, if any. */
  workflow?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** The agent's own plan, from its todo calls or the progress tool. */
  items?: Item[]
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

/** The live `/zero-selftest` run, if any. Its evidence lives in a module buffer, not here. */
export type SelftestRun = {
  runId: string
  path: 'todo' | 'progress'
  /** `running` keeps the guards up; `ended` drops them. */
  status: 'running' | 'ended'
  /** Index into the scenario of the step submitted last; -1 before the first. */
  step: number
  /** The submitted step's own turn has started. */
  isStepStarted: boolean
  /** A main turn runs now. */
  isMainBusy: boolean
  startedAt: number
  /** The last turn start or end, main or subagent: the driver waits for a quiet gap after it. */
  activeAt: number
  /** Where the trace and report are written. */
  file: string
}

declare module 'claude-code' {
  interface PluginState {
    'zero-progress': {
      bar: Bar | null
      agents: AgentRun[]
      panel: Panel
      now: number
      selftest: SelftestRun | null
    }
  }
}
