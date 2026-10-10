import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { SCENARIO, evaluate, firstLine, newTrace } from '../hooks/selftest'
import type { StepId, Trace, TraceEvent, TraceInput } from '../hooks/selftest'
import type { Bar, Item, ItemStatus } from '../types'

// ---------------------------------------------------------------------------
// The grader, on traces built by hand: a run that went right, and three that did not.

const item = (title: string, status: ItemStatus, active?: string): Item => ({ id: title, title, status, active })

const barOf = (title: string, startedAt: number, items: Item[], isFinished = true): Bar => ({
  title,
  items,
  isTurnOver: true,
  isFinished,
  startedAt,
  steps: 1,
  tokens: 0,
  costUsd: 0,
  model: 'claude-opus-5-5',
})

const textOf = (id: StepId): string => SCENARIO.find(s => s.id === id)?.text.todo ?? ''

const goodTrace = (): Trace => {
  const t = newTrace({ runId: 'r1', root: '/repo', version: '0.1.0', path: 'todo', autoOpen: true, startedAt: 0 })
  let at = 0
  const add = (ev: TraceInput) => t.events.push({ ...ev, at: at++, step: t.step } as TraceEvent)
  const begin = (id: StepId) => {
    t.step = id
    add({ kind: 'submit' })
    add({ kind: 'turn', phase: 'start', title: firstLine(textOf(id)) })
  }
  const band = (headline: string, label: string, side: string) => add({ kind: 'band', headline, label, side })
  const snap = (bar: Bar | null) => add({ kind: 'snap', bar, agents: [] })

  const s1 = firstLine(textOf('s1'))
  begin('s1')
  band(s1, 'Thinking', '0:01')
  band(s1, '1 step', '0:02')
  add({ kind: 'turn', phase: 'complete', reason: 'answer' })
  band(s1, 'Done', '0:03')
  snap(barOf(s1, 100, []))

  const s2 = firstLine(textOf('s2'))
  const steps = ['Count lines', 'List hooks', 'Count tests', 'Summarize']
  const actives = ['Counting lines', 'Listing hooks', 'Counting tests', 'Summarizing']
  begin('s2')
  add({ kind: 'tool', tool: 'TodoWrite' })
  band(actives[0] ?? '', '0/4', '0%')
  add({ kind: 'pane', planHead: 'Plan · 0/4', items: ['● Counting lines', '○ List hooks', '○ Count tests', '○ Summarize'], rows: [] })
  band(actives[1] ?? '', '1/4', '25%')
  add({ kind: 'pane', planHead: 'Plan · 1/4', items: ['✓ Count lines', '● Listing hooks', '○ Count tests', '○ Summarize'], rows: [] })
  band(actives[2] ?? '', '2/4', '50%')
  band(actives[3] ?? '', '3/4', '75%')
  add({ kind: 'turn', phase: 'complete', reason: 'answer' })
  band(s2, 'Done', '100%')
  snap(barOf(s2, 200, steps.map((s, i) => item(s, 'completed', actives[i]))))

  const s3 = firstLine(textOf('s3'))
  begin('s3')
  band(s3, '0/3', '0%')
  add({ kind: 'spawn', type: 'Explore', costume: 'explore', agentId: 'x' })
  add({ kind: 'spawn', type: 'general-purpose', costume: 'heavy', agentId: 'g' })
  add({ kind: 'panes', isOpen: true, isPlaced: true })
  band('Spawning both', '1/3', '33%')
  for (const d of [0, 1, 2, 3]) add({ kind: 'row', agentId: 'g', type: 'general-purpose', stepDone: d, stepTotal: 3, stepNote: d < 3 ? 'Counting' : undefined })
  add({ kind: 'turn', phase: 'complete', reason: 'answer' })
  band(s3, 'Waiting · 1', '33%')
  add({ kind: 'turn', phase: 'complete', agentId: 'g', reason: 'answer' })
  band(s3, 'Done', '100%')
  snap(barOf(s3, 300, [item('Explore', 'completed'), item('Count', 'completed'), item('Combine', 'completed')]))

  const s4 = firstLine(textOf('s4a'))
  begin('s4a')
  band('Reading README', '0/3', '0%')
  band('Reading LICENSE', '1/3', '33%')
  add({ kind: 'turn', phase: 'complete', reason: 'answer' })
  band(s4, 'Stopped 1/3', '33%')
  snap(barOf(s4, 400, [item('README', 'completed'), item('LICENSE', 'pending'), item('types', 'pending')]))

  begin('s4b')
  band('Reading types', '1/2', '50%')
  add({ kind: 'turn', phase: 'complete', reason: 'answer' })
  band(s4, 'Done', '100%')
  snap(barOf(s4, 400, [item('README', 'completed'), item('types', 'completed')]))

  t.step = 's5'
  add({ kind: 'submit' })
  add({ kind: 'dismiss', isNull: true })
  add({ kind: 'turn', phase: 'start', title: 'Say OK.' })
  band('Say OK.', 'Thinking', '0:01')
  band('Say OK.', 'Done', '0:02')
  snap(barOf('Say OK.', 600, []))

  t.status = 'done'
  return t
}

const failsOf = (t: Trace): string[] => evaluate(t).filter(r => r.result !== 'pass').map(r => `${r.section} · ${r.check}`)

test('every scenario prompt has a short first line, the title the bar shows', () => {
  for (const s of SCENARIO) {
    for (const text of Object.values(s.text)) expect(firstLine(text).length).toBeLessThanOrEqual(60)
  }
  expect(SCENARIO.at(-1)?.text.todo).toBe('Say OK.')
})

test('a run that went right passes every check', () => {
  expect(failsOf(goodTrace())).toEqual([])
})

test("a main bar that took the subagent's list fails the subagents check", () => {
  const t = goodTrace()
  const at = t.events.findIndex(e => e.step === 's3' && e.kind === 'band' && e.label === '1/3')
  t.events.splice(at + 1, 0, { kind: 'band', headline: 'Counting', label: '2/6', side: '33%', at: 0, step: 's3' })
  expect(failsOf(t)).toEqual(["Subagents (s3) · Main bar keeps its own 3 steps, never the subagent's"])
})

test('an activity bar that never reached Done fails', () => {
  const t = goodTrace()
  t.events = t.events.filter(e => !(e.step === 's1' && e.kind === 'band' && e.label === 'Done'))
  expect(failsOf(t)).toEqual(['Activity bar (s1) · Ends on Done'])
})

test('a deleted step that left the total at 3 fails', () => {
  const t = goodTrace()
  t.events = t.events.map(e =>
    e.step === 's4b' && e.kind === 'snap' && e.bar
      ? { ...e, bar: { ...e.bar, items: [item('README', 'completed'), item('LICENSE', 'completed'), item('types', 'completed')] } }
      : e,
  )
  expect(failsOf(t)).toEqual(['Carry over (s4) · Total drops to 2 and ends on Done'])
})

test('on the progress path the main agent must call the progress tool', () => {
  const t = { ...goodTrace(), path: 'progress' as const }
  expect(failsOf(t)).toEqual(['Progress tool (s2) · Main agent calls the progress tool'])
})

test('a step that never ran is skipped, and the run fails', () => {
  const t = goodTrace()
  t.events = t.events.filter(e => e.step !== 's5')
  t.status = 'timed-out'
  t.ending = 'step s5 ran past 5 minutes'
  const rows = evaluate(t)
  expect(rows.find(r => r.section === '0. Run')?.result).toBe('fail')
  expect(rows.filter(r => r.section === 'Dismiss (s5)').map(r => r.result)).toEqual(['skip', 'skip'])
})

// ---------------------------------------------------------------------------
// The driver, against a mocked engine.

const shown = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount({ plugin: 'zero-progress', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } } as never)
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  await ui.unmount()
  return text
}

type Seen = { prompts: { text: string; asUser: boolean }[]; files: Map<string, string>; logs: string[] }

const core = (on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/t' })
  const seen: Seen = { prompts: [], files: new Map(), logs: [] }
  // The engine's own band: an empty Box, which the kit can draw.
  on('ui.render', async () => ({ type: 'Box' }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined } as never
  })
  on('tool.list', async () => ({ value: ['Read', 'TaskCreate', 'TaskUpdate'].map(name => ({ name, description: '', mcp: false })) }) as never)
  on('fs.read', async (_$, e) => ({ value: seen.files.get(e.path) ?? '{"version":"9.9.9"}' }) as never)
  on('fs.write', async (_$, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('prompt.submit', async (_$, e) => {
    const o = e.origin
    seen.prompts.push({ text: e.text, asUser: o.kind === 'plugin' && o.asUser === true })
    return { text: e.text }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  return { clock, seen }
}

const run = ($: Engine, args = '') => $.command.run({ command: 'zero-selftest', args } as never)

// The reason a call was refused, or undefined when it went through.
const refusal = async ($: Engine, call: Record<string, unknown>): Promise<string | undefined> => {
  const ran = (await $.tool.call(call as never)) as { deny?: string }
  return ran.deny
}

const write = ($: Engine) => refusal($, { tool: 'Write', file_path: 'x.md', content: 'y' })

test('the ✕ hides the bar', async ($, on) => {
  core(on)
  await $.turn.start({ text: 'Hide me', turnId: 't1' })
  const ui = await $.ui.mount({ plugin: 'zero-progress', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } } as never)
  await ui.press({ key: 'zero-dismiss' })
  await ui.unmount()
  // A hand-back carries on a bar that is still there; after the ✕ it starts a new one.
  await $.turn.start({ text: '', turnId: 't2' })
  const text = await shown($)
  expect(text).toContain('Working')
  expect(text).not.toContain('Hide me')
})

test('while a run is live, writes and suggestions are off and reads pass; stop ends it', async ($, on) => {
  const { seen } = core(on)
  const { text } = await run($)
  expect(text).toContain('todo path')
  expect(text).toContain('v9.9.9')
  expect([...seen.files.keys()][0]).toStartWith('/home/t/.claude/zero-progress/selftest-')

  expect(await write($)).toContain('self-test is running')
  expect(await refusal($, { tool: 'Bash', command: 'git push' })).toContain('Bash is off')
  expect(await refusal($, { tool: 'AskUserQuestion', questions: [] })).toContain('plain text')
  expect(await refusal($, { tool: 'Read', file_path: 'x.md' })).toBeUndefined()
  expect((await $.prompt.suggest({ text: 'push it', origin: { kind: 'suggestion' } })).isShown).toBe(false)

  expect((await run($, 'stop')).text).toContain('stopped')
  expect(await write($)).toBeUndefined()
  expect(seen.prompts).toEqual([])
})

test('an outside prompt ends the run but still goes through', async ($, on) => {
  const { seen } = core(on)
  await run($)
  await $.prompt.submit({ text: 'what now?', origin: { kind: 'composer' }, wait: false })
  expect(seen.prompts.map(p => p.text)).toEqual(['what now?'])
  expect(seen.logs.join('\n')).toContain('interrupted by an outside prompt (composer)')
  expect(await write($)).toBeUndefined()
})

test('the driver types each step once the session is quiet, then asks for a review', async ($, on) => {
  const { clock, seen } = core(on)
  await run($)
  for (const [i, step] of SCENARIO.entries()) {
    await clock.advance(3000)
    expect(seen.prompts).toHaveLength(i + 1)
    expect(seen.prompts[i]).toEqual({ text: step.text.todo, asUser: true })
    // A subagent ending mid-turn sets a timer; the main turn still runs, so it submits nothing.
    await $.turn.start({ text: step.text.todo, turnId: `t${i}` })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${i}`, agentId: 'a9' } as never)
    await clock.advance(3000)
    expect(seen.prompts).toHaveLength(i + 1)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${i}` } as never)
  }
  await clock.advance(3000)
  const review = seen.prompts.at(-1)
  expect(review?.asUser).toBe(false)
  expect(review?.text).toContain('Zero Progress self-test finished (todo path, all steps ran)')
  const report = JSON.parse([...seen.files.values()].at(-1) ?? '{}') as Trace
  expect(report.status).toBe('done')
  expect(report.results?.find(r => r.section === '0. Run')?.result).toBe('pass')
  expect(await write($)).toBeUndefined()
})
