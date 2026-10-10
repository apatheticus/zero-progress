import type { AgentRun, Bar } from '../types'

// The self-test's script and its grader. No `$` here: register.tsx drives the run
// and records the trace; this file says what to type and whether the trace passed.

export type Path = 'todo' | 'progress'

export type StepId = 's1' | 's2' | 's3' | 's4a' | 's4b' | 's5'

/** What the driver does before it submits the step's prompt. */
export type Before = 'open-pane' | 'close-pane' | 'dismiss'

export type Step = { id: StepId; before?: Before; text: Record<Path, string> }

export const PROGRESS_TOOL = 'mcp__zero-progress__progress'

const READ_ONLY = "Don't edit any files, and use only the Read, Grep and Glob tools."

const SUBAGENT_LIST =
  'tell it to track those 3 counts as 3 steps with its own todo tool, or with the ' + PROGRESS_TOOL + ' tool if it has no todo tool'

// The prompts of docs/live-test.md, each with a short first line: that line is the bar's title.
// The progress path asks for the same work without naming a todo list.
export const SCENARIO: readonly Step[] = [
  {
    // A bar left from earlier work, with steps open, would carry the first prompt over.
    id: 's1',
    before: 'dismiss',
    text: {
      todo: 'Self-test 1: what is in hooks/hooks.json?\nAnswer in one line. Use no tool besides Read.',
      progress: 'Self-test 1: what is in hooks/hooks.json?\nAnswer in one line. Use no tool besides Read.',
    },
  },
  {
    id: 's2',
    before: 'open-pane',
    text: {
      todo:
        `Self-test 2: a four-step todo list.\n${READ_ONLY} Make a todo list with these 4 steps, then work through them one at a time, marking each in progress and then done:\n` +
        "1. Count the lines in hooks/register.tsx\n2. List every on('...') hook it registers\n3. Count the tests in tests/bar.test.ts\n4. Summarize in 3 lines",
      progress:
        `Self-test 2: a four-step plan.\n${READ_ONLY} Work through these 4 steps one at a time, showing your progress as you go:\n` +
        "1. Count the lines in hooks/register.tsx\n2. List every on('...') hook it registers\n3. Count the tests in tests/bar.test.ts\n4. Summarize in 3 lines",
    },
  },
  {
    id: 's3',
    before: 'close-pane',
    text: {
      todo:
        `Self-test 3: two subagents in parallel.\n${READ_ONLY} You may also use the Agent tool. Make a 3-step todo list: ` +
        `(1) spawn an Explore subagent to find the longest function in hooks/register.tsx, (2) spawn a general-purpose subagent to count the tests, constants and type exports in this repo; ${SUBAGENT_LIST}, (3) combine both answers. ` +
        'Run both subagents in parallel, and tell both to use only Read, Grep and Glob.',
      progress:
        `Self-test 3: two subagents in parallel.\n${READ_ONLY} You may also use the Agent tool. Work through 3 steps, showing your progress as you go: ` +
        `(1) spawn an Explore subagent to find the longest function in hooks/register.tsx, (2) spawn a general-purpose subagent to count the tests, constants and type exports in this repo; ${SUBAGENT_LIST}, (3) combine both answers. ` +
        'Run both subagents in parallel, and tell both to use only Read, Grep and Glob.',
    },
  },
  {
    id: 's4a',
    text: {
      todo:
        `Self-test 4: carry a plan over.\n${READ_ONLY} Make a 3-step todo list: (1) read README.md, (2) read LICENSE, (3) read types/index.d.ts. ` +
        'Do step 1 only, then stop and ask me in plain text whether to continue. Use no question tool.',
      progress:
        `Self-test 4: carry a plan over.\n${READ_ONLY} Plan 3 steps and show your progress as you go: (1) read README.md, (2) read LICENSE, (3) read types/index.d.ts. ` +
        'Do step 1 only, then stop and ask me in plain text whether to continue. Use no question tool.',
    },
  },
  {
    id: 's4b',
    text: {
      todo: 'Delete step 2 from the list, then finish step 3.',
      progress: 'Delete step 2 from the list, then finish step 3.',
    },
  },
  { id: 's5', before: 'dismiss', text: { todo: 'Say OK.', progress: 'Say OK.' } },
]

export const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? ''

// ---------------------------------------------------------------------------
// The trace: what happened, in order, each event tagged with the step it ran in.

export type PaneRow = { type: string; costume: string; status: string; steps: string; stepNote?: string }

export type TraceEvent = { at: number; step: StepId | null } & (
  | { kind: 'submit' }
  | { kind: 'turn'; phase: 'start' | 'complete'; agentId?: string; title?: string; reason?: string }
  | { kind: 'tool'; tool: string; agentId?: string }
  | { kind: 'spawn'; type: string; costume: string; agentId?: string }
  | { kind: 'panes'; isOpen: boolean; isPlaced: boolean }
  | { kind: 'row'; agentId: string; type: string; stepDone: number; stepTotal: number; stepNote?: string }
  | { kind: 'band'; headline: string; label: string; side: string }
  | { kind: 'pane'; planHead: string; items: string[]; rows: PaneRow[] }
  | { kind: 'snap'; bar: Bar | null; agents: AgentRun[] }
  | { kind: 'dismiss'; isNull: boolean }
  | { kind: 'note'; text: string }
)

/** An event as a hook hands it in: the driver stamps the time and the step. */
export type TraceInput = TraceEvent extends infer E ? (E extends unknown ? Omit<E, 'at' | 'step'> : never) : never

export type RunStatus = 'running' | 'done' | 'stopped' | 'interrupted' | 'timed-out'

export type Verdict = 'pass' | 'fail' | 'skip'

export type CheckResult = { section: string; check: string; result: Verdict; evidence: string }

export type Trace = {
  runId: string
  root: string
  version: string
  path: Path
  autoOpen: boolean
  startedAt: number
  endedAt?: number
  status: RunStatus
  ending?: string
  step: StepId | null
  scenario: { id: StepId; text: string }[]
  events: TraceEvent[]
  results?: CheckResult[]
}

export const newTrace = (t: Pick<Trace, 'runId' | 'root' | 'version' | 'path' | 'autoOpen' | 'startedAt'>): Trace => ({
  ...t,
  status: 'running',
  step: null,
  scenario: SCENARIO.map(s => ({ id: s.id, text: s.text[t.path] })),
  events: [],
})

// ---------------------------------------------------------------------------
// The grader: one row per box of docs/live-test.md, from the trace alone.

type Of<K extends TraceEvent['kind']> = Extract<TraceEvent, { kind: K }>

const is =
  <K extends TraceEvent['kind']>(kind: K) =>
  (e: TraceEvent): e is Of<K> =>
    e.kind === kind

const inStep = (events: TraceEvent[], step: StepId): TraceEvent[] => events.filter(e => e.step === step)

const isMainStart = (e: TraceEvent): boolean => e.kind === 'turn' && e.phase === 'start' && !e.agentId

const ran = (events: TraceEvent[], step: StepId): boolean => inStep(events, step).some(isMainStart)

// What the band drew once the step's own turn had started.
const bandsIn = (events: TraceEvent[], step: StepId): Of<'band'>[] => {
  const mine = inStep(events, step)
  const from = mine.findIndex(isMainStart)
  return from < 0 ? [] : mine.slice(from).filter(is('band'))
}

const snapOf = (events: TraceEvent[], step: StepId): Of<'snap'> | undefined => inStep(events, step).filter(is('snap')).at(-1)

const fraction = (label: string): [number, number] | null => {
  const m = /^(?:Stopped )?(\d+)\/(\d+)$/.exec(label)
  return m ? [Number(m[1]), Number(m[2])] : null
}

const doneIn = (b: Bar): number => b.items.filter(i => i.status === 'completed').length

const quote = (s: string): string => JSON.stringify(s)

const distinct = (xs: string[]): string[] => [...new Set(xs)]

const isTodoTool = (tool: string): boolean => tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate'

type Row = [Verdict, string]

export const evaluate = (trace: Trace): CheckResult[] => {
  const ev = trace.events
  const out: CheckResult[] = []
  const check = (section: string, name: string, step: StepId | null, fn: () => Row): void => {
    if (step && !ran(ev, step)) {
      out.push({ section, check: name, result: 'skip', evidence: `step ${step} never ran` })
      return
    }
    const [result, evidence] = fn()
    out.push({ section, check: name, result, evidence })
  }
  const text = (id: StepId): string => trace.scenario.find(s => s.id === id)?.text ?? ''
  const isTodo = trace.path === 'todo'

  check('0. Run', 'Every step ran', null, () => {
    const reached = SCENARIO.filter(s => ran(ev, s.id)).map(s => s.id)
    return trace.status === 'done'
      ? ['pass', `ran ${reached.join(', ')}`]
      : ['fail', `${trace.ending ?? trace.status}; ran ${reached.join(', ') || 'nothing'}`]
  })

  // 1. No plan: activity bar.
  const s1 = 'Activity bar (s1)'
  check(s1, "Bar is titled with the prompt's first line", 's1', () => {
    const want = firstLine(text('s1'))
    const heads = distinct(bandsIn(ev, 's1').map(b => b.headline))
    return heads.includes(want) ? ['pass', `band headline ${quote(want)}`] : ['fail', `want ${quote(want)}, band showed ${heads.map(quote).join(', ') || 'nothing'}`]
  })
  check(s1, 'Shows Thinking or a step count, no percent, while it runs', 's1', () => {
    const live = bandsIn(ev, 's1').filter(b => b.label !== 'Done')
    if (!live.length) return ['fail', 'no band was drawn while s1 ran']
    const bad = live.filter(b => !/^(Thinking|\d+ steps?)$/.test(b.label) || b.side.includes('%'))
    return bad.length
      ? ['fail', `band read ${bad.map(b => quote(`${b.label} ${b.side}`)).join(', ')}`]
      : ['pass', `labels ${distinct(live.map(b => b.label)).join(', ')}`]
  })
  check(s1, 'Ends on Done', 's1', () => {
    const last = bandsIn(ev, 's1').at(-1)
    return last?.label === 'Done' ? ['pass', 'last band label Done'] : ['fail', `last band label ${quote(last?.label ?? 'none')}`]
  })

  // 2. A plan drives the bar.
  const s2 = isTodo ? 'Todo list (s2)' : 'Progress tool (s2)'
  check(s2, 'Plan reaches 4 items', 's2', () => {
    const b = snapOf(ev, 's2')?.bar
    return b?.items.length === 4 ? ['pass', `bar items: ${b.items.map(i => i.title).join(' | ')}`] : ['fail', `bar after s2 had ${b ? b.items.length : 'no'} items`]
  })
  check(s2, 'Done climbs to 4 and never goes back', 's2', () => {
    const ds = bandsIn(ev, 's2')
      .map(b => fraction(b.label))
      .filter((f): f is [number, number] => f !== null && f[1] === 4)
      .map(f => f[0])
    const b = snapOf(ev, 's2')?.bar
    const end = b ? doneIn(b) : 0
    const isMonotone = ds.every((d, i) => i === 0 || d >= (ds[i - 1] ?? 0))
    const seq = [...ds, end].join('→')
    if (!ds.length) return ['fail', 'the band never showed d/4']
    return isMonotone && end === 4 ? ['pass', `done ${seq}`] : ['fail', `done ${seq}`]
  })
  check(s2, 'Names the step at hand, not just the prompt', 's2', () => {
    const b = snapOf(ev, 's2')?.bar
    const names = (b?.items ?? []).flatMap(i => [i.active, i.title]).filter((n): n is string => !!n)
    const hit = bandsIn(ev, 's2').find(x => names.includes(x.headline) && x.headline !== b?.title)
    return hit ? ['pass', `band headline ${quote(hit.headline)}`] : ['fail', `headlines ${distinct(bandsIn(ev, 's2').map(x => quote(x.headline))).join(', ')}`]
  })
  check(s2, 'Percent matches done/total', 's2', () => {
    const counted = bandsIn(ev, 's2').filter(b => fraction(b.label))
    if (!counted.length) return ['fail', 'the band never showed a count']
    const bad = counted.filter(b => {
      const [d, n] = fraction(b.label) ?? [0, 1]
      return b.side !== `${Math.round((d / n) * 100)}%`
    })
    return bad.length ? ['fail', bad.map(b => quote(`${b.label} ${b.side}`)).join(', ')] : ['pass', distinct(counted.map(b => `${b.label}=${b.side}`)).join(', ')]
  })
  const mainTools = inStep(ev, 's2').filter(is('tool')).filter(t => !t.agentId)
  const progressCalls = mainTools.filter(t => t.tool === PROGRESS_TOOL).length
  if (isTodo) {
    check(s2, 'Main agent uses its todo tool', 's2', () => {
      const n = mainTools.filter(t => isTodoTool(t.tool)).length
      return n ? ['pass', `${n} todo tool calls`] : ['fail', 'no TodoWrite, TaskCreate or TaskUpdate call']
    })
    check(s2, 'Main agent never calls the progress tool', 's2', () =>
      progressCalls ? ['fail', `${progressCalls} progress tool calls`] : ['pass', '0 progress tool calls'],
    )
  } else {
    check(s2, 'Main agent calls the progress tool', 's2', () =>
      progressCalls ? ['pass', `${progressCalls} progress tool calls`] : ['fail', '0 progress tool calls'],
    )
  }
  check(s2, 'Agents pane shows Plan · d/4 with ✓ and ○', 's2', () => {
    const panes = inStep(ev, 's2').filter(is('pane'))
    if (!panes.length) return ['skip', 'the pane never drew during s2 (closed, or waiting undrawn on a narrow terminal)']
    const hit = panes.find(p => /\/4$/.test(p.planHead) && p.items.some(i => i.startsWith('✓')) && p.items.some(i => i.startsWith('○')))
    return hit ? ['pass', `${quote(hit.planHead)}: ${hit.items.join(' | ')}`] : ['fail', `pane heads ${distinct(panes.map(p => quote(p.planHead))).join(', ')}`]
  })

  // 3. Subagents.
  const s3 = 'Subagents (s3)'
  const spawns = inStep(ev, 's3').filter(is('spawn'))
  check(s3, 'Agents pane opens at the first subagent', 's3', () => {
    if (!trace.autoOpen) return ['skip', 'autoOpen is off in /config']
    if (!spawns.length) return ['fail', 'no subagent was spawned']
    const seen = inStep(ev, 's3').filter(is('panes'))[0]
    if (!seen) return ['fail', 'no pane check after the spawn']
    if (!seen.isOpen) return ['fail', 'zero-agents was not open after the first spawn']
    return ['pass', seen.isPlaced ? 'open and drawn' : 'open, but waiting undrawn (isPlaced false): terminal under 144 columns']
  })
  check(s3, 'Explore row wears the pirate crab', 's3', () => {
    const x = spawns.find(s => s.type === 'Explore')
    if (!x) return ['fail', `no Explore spawn; spawned ${spawns.map(s => s.type).join(', ') || 'nothing'}`]
    return x.costume === 'explore' ? ['pass', 'costume explore'] : ['fail', `costume ${x.costume}`]
  })
  check(s3, 'General-purpose row shows its own d/3 and step name', 's3', () => {
    const rows = inStep(ev, 's3').filter(is('row')).filter(r => r.type === 'general-purpose')
    if (!rows.length) return ['fail', 'the general-purpose subagent never reported steps']
    const named = rows.find(r => r.stepTotal === 3 && r.stepNote)
    const top = Math.max(...rows.map(r => (r.stepTotal === 3 ? r.stepDone : 0)))
    const seq = rows.map(r => `${r.stepDone}/${r.stepTotal}`).join('→')
    return named && top === 3 ? ['pass', `${seq}, step ${quote(named.stepNote ?? '')}`] : ['fail', `rows ${seq}${named ? '' : ', never named a step'}`]
  })
  check(s3, "Main bar keeps its own 3 steps, never the subagent's", 's3', () => {
    const counted = bandsIn(ev, 's3').map(b => fraction(b.label)).filter((f): f is [number, number] => f !== null)
    const b = snapOf(ev, 's3')?.bar
    const totals = distinct([...counted.map(f => String(f[1])), String(b?.items.length ?? 0)])
    return totals.length === 1 && totals[0] === '3' ? ['pass', 'total 3 throughout'] : ['fail', `totals seen: ${totals.join(', ')}`]
  })
  check(s3, 'Waiting · N while subagents outlive the main turn', 's3', () => {
    const w = bandsIn(ev, 's3').find(b => b.label.startsWith('Waiting · '))
    return w ? ['pass', `band ${quote(w.label)}`] : ['skip', 'the main turn never ended while a subagent ran']
  })
  check(s3, 'Settles to Done', 's3', () => {
    const last = bandsIn(ev, 's3').at(-1)
    return last?.label === 'Done' ? ['pass', 'last band label Done'] : ['fail', `last band label ${quote(last?.label ?? 'none')}`]
  })

  // 4. Carry over and delete.
  const s4 = 'Carry over (s4)'
  check(s4, 'Sits at 1/3, not Done, after the pause', 's4a', () => {
    const b = snapOf(ev, 's4a')?.bar
    const last = bandsIn(ev, 's4a').at(-1)
    const f = fraction(last?.label ?? '')
    const ok = b && b.items.length === 3 && doneIn(b) === 1 && f?.[0] === 1 && f[1] === 3
    return ok ? ['pass', `last band ${quote(last?.label ?? '')}`] : ['fail', `bar ${b ? `${doneIn(b)}/${b.items.length}` : 'none'}, last band ${quote(last?.label ?? 'none')}`]
  })
  check(s4, 'The follow-up keeps the same bar', 's4b', () => {
    const a = snapOf(ev, 's4a')?.bar
    const b = snapOf(ev, 's4b')?.bar
    if (!a || !b) return ['fail', `bar missing ${a ? 'after s4b' : 'after s4a'}`]
    return a.startedAt === b.startedAt && a.title === b.title
      ? ['pass', `title ${quote(b.title)}, started ${b.startedAt}`]
      : ['fail', `${quote(a.title)}@${a.startedAt} became ${quote(b.title)}@${b.startedAt}`]
  })
  check(s4, 'Total drops to 2 and ends on Done', 's4b', () => {
    const b = snapOf(ev, 's4b')?.bar
    const last = bandsIn(ev, 's4b').at(-1)
    const ok = b && b.items.length === 2 && doneIn(b) === 2 && last?.label === 'Done'
    return ok ? ['pass', `items ${b.items.map(i => i.title).join(' | ')}`] : ['fail', `bar ${b ? `${doneIn(b)}/${b.items.length}` : 'none'}, last band ${quote(last?.label ?? 'none')}`]
  })

  // 5. Dismiss.
  const s5 = 'Dismiss (s5)'
  check(s5, 'Dismiss hides the bar', 's5', () => {
    const d = inStep(ev, 's5').find(is('dismiss'))
    return d?.isNull ? ['pass', 'bar null after dismiss'] : ['fail', d ? 'bar still set after dismiss' : 'no dismiss recorded']
  })
  check(s5, 'The next prompt brings a new bar', 's5', () => {
    const before = snapOf(ev, 's4b')?.bar
    const b = snapOf(ev, 's5')?.bar
    const want = firstLine(text('s5'))
    if (!b) return ['fail', 'no bar after s5']
    return b.title === want && b.startedAt !== before?.startedAt ? ['pass', `new bar ${quote(b.title)}`] : ['fail', `bar ${quote(b.title)}@${b.startedAt}`]
  })
  return out
}

export const tally = (results: CheckResult[]) => ({
  passed: results.filter(r => r.result === 'pass').length,
  failed: results.filter(r => r.result === 'fail').length,
  skipped: results.filter(r => r.result === 'skip').length,
})

const MARK: Record<Verdict, string> = { pass: '✓', fail: '✗', skip: '–' }

export const resultLine = (r: CheckResult): string => `${MARK[r.result]} ${r.section} · ${r.check}: ${r.evidence}`

// The last prompt: the model reads the trace and judges each fail and skip.
export const reviewPrompt = (trace: Trace, file: string): string => {
  const t = tally(trace.results ?? [])
  const todo =
    trace.path === 'todo'
      ? ' If every check passed, recommend adding "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" to the env block in ~/.claude/settings.json, but do not add it yourself.'
      : ''
  return (
    `Zero Progress self-test finished (${trace.path} path, ${trace.ending ?? trace.status}): ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped. Report: ${file}. ` +
    'For every fail or skip, read the trace and say whether the mod is wrong or the model did not follow the scenario prompt, quoting the trace events. Don\'t edit files.' +
    todo +
    ' End with: `Zero Progress self-test: passed __ / failed __ / skipped __. Notes: __`'
  )
}
