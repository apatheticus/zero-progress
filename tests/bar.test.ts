import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The kit reads state only through what the plugin draws: the band's text says it all.
const shown = async ($: Engine, component: 'AbovePrompt' | 'Pane' = 'AbovePrompt'): Promise<string> => {
  const target = component === 'Pane' ? { component, requestId: 'zero-agents', props: { bodyColumns: 80 } } : { component, props: { bodyColumns: 120, hasSurvey: false } }
  const ui = await $.ui.mount({ plugin: 'zero-progress', surface: 'terminal', ...target } as never)
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  await ui.unmount()
  return text
}

// The engine's side of each event the plugin hooks: what core would answer.
let nextTask = 1
const core = (on: On) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.render', async () => ({ type: 'Box' }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }) as never)
  on('tool.call', async (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(nextTask++), subject: input.subject } } } as never
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: input.taskId, updatedFields: ['status'] } } as never
    return { result: { oldTodos: [], newTodos: [] } } as never
  })
}

const start = ($: Engine, text: string) => $.turn.start({ text, turnId: `t-${text.length}` })

const complete = ($: Engine, agentId?: string) =>
  $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', ...(agentId ? { agentId } : {}) } as never)

test('a typed prompt starts an activity bar named after its first line', async ($, on) => {
  core(on)
  await start($, 'Fix the login bug\nwith more detail below')
  const text = await shown($)
  expect(text).toContain('Fix the login bug')
  expect(text).toContain('Thinking')
})

test('TodoWrite drives the main bar', async ($, on) => {
  core(on)
  await start($, 'Do three things')
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ],
  } as never)
  const text = await shown($)
  expect(text).toContain('Writing')
  expect(text).toContain('1/3')
  expect(text).toContain('33%')
})

test('TaskCreate adds steps and TaskUpdate moves them', async ($, on) => {
  nextTask = 1
  core(on)
  await start($, 'Plan with tasks')
  await $.tool.call({ tool: 'TaskCreate', subject: 'First', description: 'x' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Second', description: 'y' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  expect(await shown($)).toContain('1/2')
  const pane = await shown($, 'Pane')
  expect(pane).toContain('✓ First')
  expect(pane).toContain('○ Second')
})

test('the progress tool sets the plan when no todo tool runs', async ($, on) => {
  core(on)
  await start($, 'Ship it')
  await $.tool.call({ tool: 'mcp__zero-progress__progress', title: 'Release', steps: ['Build', 'Test', 'Tag'], done: 1 } as never)
  const text = await shown($)
  expect(text).toContain('Test')
  expect(text).toContain('1/3')
  expect(await shown($, 'Pane')).toContain('Release')
})

test("a subagent's todo list lands on its own row, not the bar", async ($, on) => {
  core(on)
  await start($, 'Delegate it')
  await $.agent.spawn({ subagentType: 'Explore', description: 'Look around', tool_use_id: 'tu1', prompt: 'look' } as never)
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'a1',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  } as never)
  expect(await shown($, 'Pane')).toContain('1/2 Doing two')
  expect(await shown($)).toContain('Thinking')
})

test('the bar waits for running subagents, then settles to Done', async ($, on) => {
  core(on)
  await start($, 'Fan out')
  await $.agent.spawn({ subagentType: 'general-purpose', description: 'Worker', tool_use_id: 'tu1', prompt: 'go' } as never)
  await complete($)
  expect(await shown($)).toContain('Waiting · 1')
  await complete($, 'a1')
  expect(await shown($)).toContain('Done')
})

test("each model step adds its tokens and cost to the bar or to the subagent's row", async ($, on) => {
  core(on)
  // What the API reports for each loop's step: main on Opus 5.5, the subagent on Haiku 5.5.
  const usage: Record<string, { model: string; input_tokens: number; output_tokens: number }> = {
    main: { model: 'claude-opus-5-5', input_tokens: 100_000, output_tokens: 10_000 },
    a1: { model: 'claude-haiku-5-5', input_tokens: 40_000, output_tokens: 10_000 },
  }
  on('turn.step', async function* (_$, e) {
    const u = usage[e.agentId ?? 'main']
    const reported = u ? { ...u, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: reported } as never
  })
  const step = async (model: string, agentId?: string, effort?: 'high') => {
    const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}), ...(effort ? { effort } : {}) })
    for await (const _ of stream);
    return stream.result
  }

  await start($, 'Count the cost')
  await $.agent.spawn({ subagentType: 'Explore', description: 'Look around', tool_use_id: 'tu1', prompt: 'look' } as never)
  await step('claude-opus-5-5')
  await step('claude-haiku-5-5', 'a1', 'high')

  // Main: 110k tokens at $4/$20 per M = $0.60, one step on the bar.
  expect(await shown($)).toContain('1 step')
  // Subagent: 50k of Haiku's 200k window = 25%, at $1/$5 per M = $0.09.
  const pane = await shown($, 'Pane')
  expect(pane).toContain('Haiku 5.5 · high')
  expect(pane).toContain('ctx 25% · 50k ≈$0.09')
  // Totals: both loops together.
  expect(pane).toContain('≈$0.69')
  expect(pane).toContain('160k tokens')
})

test('the band draws on the terminal and the desktop', async ($, on) => {
  core(on)
  await start($, 'Draw me')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'zero-progress', surface, component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } } as never)
    expect(await ui.find({ key: 'zero-dismiss' })).toBeDefined()
    await ui.unmount()
  }
})

test('a lower hook keeps its row, drawn under the bar', async ($, on) => {
  // Registered first, so it stands above core's catch-all: the plugin's `next` reaches it.
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', children: [{ type: 'Text', children: ['Context row'] }] }) as never)
  core(on)
  await start($, 'Stack me')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'zero-progress', surface, component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } } as never)
    const text = JSON.stringify(await ui.drawn())
    expect(text).toContain('Context row')
    expect(text.indexOf('zero-dismiss')).toBeLessThan(text.indexOf('Context row'))
    await ui.unmount()
  }
})

test('the prompt names the progress tool only when no todo tool is offered', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], outputStyle: null, traits: [] }
  const ids = async (tools: string[]) => (await $.prompt.compose({ ...base, tools })).sections.map(s => s.id)
  expect(await ids(['Bash', 'mcp__zero-progress__progress'])).toEqual(['intro', 'zero-progress:progress'])
  expect(await ids(['Bash', 'TodoWrite', 'mcp__zero-progress__progress'])).toEqual(['intro'])
  expect(await ids(['Bash'])).toEqual(['intro'])
})
