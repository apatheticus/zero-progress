import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Bar, Item, ItemStatus, Panel } from '../types'

// Forked from savvy-progress by johnnyvizz (MIT): the drawing code is his; the bar's
// sources are new. Nothing here needs a skill: the bar reads the todo tools when they
// are on, the up-front `progress` tool when they are off, and turn activity otherwise.

const bar = atom({ plugin: 'zero-progress', key: 'bar' } as const, null)
const agents = atom({ plugin: 'zero-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'zero-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'zero-progress', key: 'now' } as const, 0)

const TOOL = 'mcp__zero-progress__progress'
const PANE = 'zero-agents'
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

const TOOL_DESCRIPTION =
  'Shows your progress on the progress bar above the prompt. For work with 3 or more steps: ' +
  'call it once the steps are known (`title`, `steps` as short labels, `done: 0`), then with `done` as each step finishes, ' +
  'and with `finished: true` at the end. Fields left out keep their value. A subagent may call it for its own task. ' +
  'Not needed when TodoWrite or TaskCreate is available: the bar reads those.'

const PROMPT_SECTION =
  'Progress bar: the person watches a progress bar fed by the `' +
  TOOL +
  '` tool. For work with 3 or more distinct steps, call it once you know the steps, then again as each one finishes. ' +
  'Skip it for quick answers.'

type ProgressInput = {
  title?: string
  steps?: string[]
  done?: number
  current?: string
  finished?: boolean
}

type TodoInput = { content?: string; status?: string; activeForm?: string }

type TaskUpdateInput = { taskId?: string; subject?: string; activeForm?: string; status?: string }

// ---------------------------------------------------------------------------
// Plans: todo lists, tasks and progress-tool steps all become Item[].

const STATUSES: readonly ItemStatus[] = ['pending', 'in_progress', 'completed']

const statusOf = (s: unknown): ItemStatus => (STATUSES.includes(s as ItemStatus) ? (s as ItemStatus) : 'pending')

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const fromTodos = (todos: TodoInput[] | undefined): Item[] =>
  (todos ?? [])
    .filter(t => str(t.content))
    .map((t, i) => ({ id: String(i + 1), title: str(t.content) ?? '', active: str(t.activeForm), status: statusOf(t.status) }))

// Steps before `done` are finished; the one at `done` runs.
const fromSteps = (steps: string[], done: number): Item[] =>
  steps.map((title, i) => ({ id: `s${i + 1}`, title, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }))

const applyProgress = (items: Item[], p: ProgressInput): Item[] => {
  const given = (p.steps ?? []).map(s => String(s).trim()).filter(Boolean)
  const steps = given.length ? given : items.map(i => i.title)
  const done = p.finished ? steps.length : Math.max(0, Math.round(p.done ?? doneOf(items)))
  return fromSteps(steps, done)
}

// Null when the task is not in this list.
const applyTaskUpdate = (items: Item[], u: TaskUpdateInput): Item[] | null => {
  const id = String(u.taskId ?? '')
  if (!items.some(i => i.id === id)) return null
  if (u.status === 'deleted') return items.filter(i => i.id !== id)
  return items.map(i =>
    i.id !== id
      ? i
      : { ...i, title: str(u.subject) ?? i.title, active: str(u.activeForm) ?? i.active, status: u.status ? statusOf(u.status) : i.status },
  )
}

const doneOf = (items: Item[]): number => items.filter(i => i.status === 'completed').length

const currentOf = (items: Item[]): Item | undefined => items.find(i => i.status === 'in_progress')

const withItems = (a: AgentRun, items: Item[], note?: string): AgentRun => {
  const c = currentOf(items)
  return { ...a, items, stepTotal: items.length, stepDone: doneOf(items), stepNote: note ?? c?.active ?? c?.title }
}

// ---------------------------------------------------------------------------
// The bar: one per task, from the prompt that starts it to Done.

const newBar = (title: string, at: number): Bar => ({
  title,
  items: [],
  isTurnOver: false,
  isFinished: false,
  startedAt: at,
  steps: 0,
  tokens: 0,
  costUsd: 0,
  model: '',
})

// A turn nobody typed: a subagent handing back, a background task's notice.
const isFollowUp = (text: string): boolean => !text.trim() || /^<(agent-message|task-notification)\b/.test(text.trim())

const isOpenPlan = (b: Bar): boolean => b.items.length > 0 && doneOf(b.items) < b.items.length

const titleOf = (text: string): string => {
  const line = text.replace(/<[^>]+>/g, ' ').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  return clip(line, 60) || 'Working'
}

const isActivity = (b: Bar): boolean => !b.isFinished && b.items.length === 0

const ratio = (b: Bar): number => (b.items.length ? doneOf(b.items) / b.items.length : b.isFinished ? 1 : 0)

const label = (b: Bar, running: number): string => {
  const n = b.items.length
  const d = doneOf(b.items)
  if (b.isFinished) return n && d < n ? `Stopped ${d}/${n}` : 'Done'
  if (b.isTurnOver && running) return `Waiting · ${running}`
  if (n) return `${d}/${n}`
  return b.steps ? `${b.steps} step${b.steps === 1 ? '' : 's'}` : 'Thinking'
}

// While it runs the bar names the step at hand; the task's title otherwise.
const headline = (b: Bar): string => {
  if (b.isFinished) return b.title
  const c = currentOf(b.items)
  return b.note || c?.active || c?.title || b.title
}

const barElapsed = (b: Bar, at: number): number => (b.endedAt ?? Math.max(at, b.startedAt)) - b.startedAt

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// ---------------------------------------------------------------------------
// Costumes by model, not by skill tier: any agent dresses right.

const COSTUME_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  explore: '#8A6F4E',
  other: '#888780',
}

const colorOf = (costume: string): string => COSTUME_COLOR[costume] ?? '#888780'

// Explore and Plan keep their own look; everyone else wears their model's:
// Fable the astronaut, Opus the detective, Sonnet the chef, Haiku the racer.
const costumeOf = (type: string, model: string): string => {
  if (type === 'Explore') return 'explore'
  if (type === 'Plan') return 'careful'
  const m = model.toLowerCase()
  if (/fable|mythos/.test(m)) return 'fable'
  if (/opus/.test(m)) return 'heavy'
  if (/sonnet/.test(m)) return 'medium'
  if (/haiku/.test(m)) return 'light'
  return 'other'
}

const dither = (cols: number, rows: number, offset = 0): string[] => {
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c + offset, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c + offset) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  return dots
}

const rowSvg = (b: Bar, W: number, running: number, at: number): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(headline(b), 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 52 - CRAB_W)
  const color = b.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const rows = Math.floor(BAR_H / CELL)
  const isBusy = isActivity(b)
  const fillW = Math.round(BAR_W * ratio(b))
  const n = b.items.length

  // No plan to measure against: a segment sweeps across instead of a made-up percent.
  // One sweep a second, so the once-a-second redraw restarts it in phase.
  const segW = Math.round(BAR_W * 0.28)
  const dots = isBusy ? dither(Math.floor(segW / CELL), rows) : dither(Math.floor(fillW / CELL), rows)

  // The step at hand: a faint second layer.
  const faint: string[] = []
  const runW = n ? Math.round((BAR_W * Math.min(n, doneOf(b.items) + (currentOf(b.items) ? 1 : 0))) / n) : 0
  for (let c = Math.floor(fillW / CELL); c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < n; i++) {
    const x = Math.round((BAR_W * i) / n)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(b, running)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = isBusy ? 0 : Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const side = n ? `${Math.round(ratio(b) * 100)}%` : fmtTime(barElapsed(b, at))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${b.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${b.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${b.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${b.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${b.isFinished ? 0.8 : 0.3}}}
.sw{animation:sw 1s ease-in-out infinite}@keyframes sw{from{transform:translateX(${-segW}px)}to{transform:translateX(${BAR_W}px)}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3,.sw{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}"${isBusy ? ' class="sw"' : ''}>${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${side}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, costumeOf('', b.model), false, !b.isFinished, 0.8)}
</svg>`
}

// Terminal: a block that slides one cell a second while there is no plan.
const barText = (b: Bar, width: number, at: number): string => {
  if (isActivity(b)) {
    const seg = Math.max(2, Math.round(width / 4))
    const pos = Math.floor(at / 1000) % (width + seg)
    return [...Array(width)].map((_, i) => (i >= pos - seg && i < pos ? '█' : '░')).join('')
  }
  const filled = Math.round(width * ratio(b))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

// The whole task: the main agent's own spend plus every subagent's.
const totals = (b: Bar | null, list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, b?.costUsd ?? 0)
  const tokens = list.reduce((s, a) => s + a.tokens, b?.tokens ?? 0)
  const starts = list.map(a => a.startedAt)
  const ends = list.map(a => a.endedAt ?? Math.max(at, a.startedAt))
  if (b) {
    starts.push(b.startedAt)
    ends.push(b.endedAt ?? Math.max(at, b.startedAt))
  }
  return { cost, tokens, time: starts.length ? Math.max(...ends) - Math.min(...starts) : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the task, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="${top + 16}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="${top + 33}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, 'Cost', '≈' + fmtCost(t.cost))}${tile(1, 'Tokens', fmtTokens(t.tokens))}${tile(2, 'Time', fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The agent's own plan when it keeps one; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const metaOf = (a: AgentRun): string => {
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.workflow) meta.push('workflow')
  if (a.round > 1) meta.push(`round ${a.round}`)
  if (a.status === 'failed') meta.push('error')
  return meta.join('  ·  ')
}

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const costume = costumeOf(a.type, a.model)
  const color = colorOf(costume)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const barW = textW
  const progress = progressOf(a)
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without a plan the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, costume, false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(a.type)}</tspan><tspan class="s">  ${xml(metaOf(a))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], t: ReturnType<typeof totals>): string => {
  const icons = [...list.filter(a => a.status === 'running'), ...list.filter(a => a.status !== 'running')].map(a => {
    const k = costumeOf(a.type, a.model)
    return { k, c: colorOf(k), s: a.status }
  })
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, false, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗' }

const ITEM_GLYPH: Record<ItemStatus, string> = { completed: '✓', in_progress: '●', pending: '○' }

const itemText = (i: Item): string => `${ITEM_GLYPH[i.status]} ${i.status === 'in_progress' ? (i.active ?? i.title) : i.title}`

// ---------------------------------------------------------------------------
// Engine work. Each takes `$`, so each is a top-level function. The tool and spawn
// hooks only watch: their `.catch` hands a failure back to the call, never refuses it.

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Agents' })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  // Unawaited so the spawn never waits on a pane; a surface that places none is fine.
  void $.ui.open({ id: PANE, title: 'Agents' }).catch(() => undefined)
}

// Ticks the clocks while something runs; quiet otherwise.
async function tick($: EngineInterface): Promise<void> {
  const b = await read($, bar)
  const list = await read($, agents)
  if (!(b && !b.isFinished) && !list.some(a => a.status === 'running')) return
  const at = await $.clock.now()
  await update($, now, () => at)
}

// The main turn is over and no subagent still runs: the bar settles to Done.
async function settle($: EngineInterface): Promise<void> {
  const b = await read($, bar)
  if (!b || !b.isTurnOver || b.isFinished) return
  const list = await read($, agents)
  if (list.some(a => a.status === 'running')) return
  const at = await $.clock.now()
  await update($, bar, prev => (prev ? { ...prev, isFinished: true, endedAt: at } : prev))
}

// A todo call that went through: a subagent's lands on its own row, the main
// agent's on the bar. A TaskUpdate a subagent makes on a shared task finds it on the bar.
async function applyTodo($: EngineInterface, tool: string, e: Record<string, unknown>, result: unknown): Promise<void> {
  const agentId = str(e.agentId)
  const change = (items: Item[]): Item[] | null => {
    if (tool === 'TodoWrite') return fromTodos(e.todos as TodoInput[] | undefined)
    if (tool === 'TaskCreate') {
      const id = String((result as { task?: { id?: unknown } } | undefined)?.task?.id ?? '')
      const title = str(e.subject)
      if (!id || !title) return null
      return [...items.filter(i => i.id !== id), { id, title, active: str(e.activeForm), status: 'pending' }]
    }
    return applyTaskUpdate(items, e as TaskUpdateInput)
  }

  if (agentId) {
    const list = await read($, agents)
    const run = list.find(a => a.agentId === agentId)
    const items = run ? change(run.items ?? []) : null
    if (items) {
      await update($, agents, l => l.map(a => (a.agentId === agentId ? withItems(a, items) : a)))
      return
    }
    if (tool !== 'TaskUpdate') return
  }
  const at = await $.clock.now()
  await update($, bar, prev => {
    const b = prev ?? newBar('Working', at)
    const items = change(b.items)
    return items ? { ...b, items, note: undefined } : prev
  })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // With the todo tools on, the bar reads those, and this tool waits behind ToolSearch.
    const flag = (await $.env.get('CLAUDE_CODE_ENABLE_TODO_TOOLS')) ?? ''
    const hasTodos = /^(1|true|yes|on)$/i.test(flag.trim())
    await $.tool.register({
      name: 'progress',
      description: TOOL_DESCRIPTION,
      isDeferred: hasTodos,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the whole task, a few words.' },
          steps: { type: 'array', items: { type: 'string' }, description: 'The plan in order, each a few words. Replaces the earlier list.' },
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          current: { type: 'string', description: 'What is happening right now, a few words.' },
          finished: { type: 'boolean', description: 'True once the task is complete.' },
        },
      },
    })
    await $.command.register({
      name: 'zero-agents',
      description: 'Show or hide the panel of subagents: running and finished, with model, plan, context, cost and time',
    })
    $.clock.every(1000, () => {
      void tick($)
    })
    return started
  })

  on('command.run', { command: 'zero-agents' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
  })

  // Only offered when the tool is in front and no todo tool is: one source of truth.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hasTodos = e.tools.some(t => t === 'TodoWrite' || t === 'TaskCreate')
    if (!e.tools.includes(TOOL) || hasTodos) return composed
    return { sections: [...composed.sections, { id: 'zero-progress:progress', text: PROMPT_SECTION, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    const prev = await read($, bar)
    // A hand-back, or a plan with steps left, carries on the same bar.
    if (prev && (isFollowUp(e.text) || isOpenPlan(prev))) {
      await update($, bar, p => (p ? { ...p, isTurnOver: false, isFinished: false, endedAt: undefined } : p))
    } else {
      await update($, bar, () => newBar(isFollowUp(e.text) ? 'Working' : titleOf(e.text), at))
      // A new task starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    await update($, now, () => at)
    return next(e)
  })

  // The engine's tool-name list is written before this mod registers its tool, so the name is cast.
  on('tool.call', { tool: TOOL as never }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const agentId = (e as { agentId?: string }).agentId
    if (agentId) {
      await update($, agents, list =>
        list.map(a => (a.agentId === agentId ? withItems(a, applyProgress(a.items ?? [], input), str(input.current)) : a)),
      )
      return { result: 'ok' }
    }
    const at = await $.clock.now()
    const b = await update($, bar, prev => {
      const base = prev ?? newBar(str(input.title) ?? 'Working', at)
      return { ...base, title: str(input.title) ?? base.title, items: applyProgress(base.items, input), note: str(input.current) }
    })
    return { result: b ? `ok: ${label(b, 0)}` : 'ok' }
  }).catch(() => ({ result: 'ok' }))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await applyTodo($, 'TodoWrite', e as unknown as Record<string, unknown>, ran.result)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await applyTodo($, 'TaskCreate', e as unknown as Record<string, unknown>, ran.result)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await applyTodo($, 'TaskUpdate', e as unknown as Record<string, unknown>, ran.result)
    return ran
  }).catch(($, e, next) => next(e))

  // Every subagent, Agent tool and Workflow alike; the id exists only once it started.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const workflow = (e as { workflow?: { runId?: string } }).workflow?.runId
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        workflow,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (options.autoOpen !== false) {
      const b = await read($, bar)
      await autoOpen($, b ? String(b.startedAt) : 'session')
    }
    return started
  }).catch(($, e, next) => next(e))

  // Each model request: the main agent's lands on the bar, a subagent's on its row.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!usage) return result
    const model = usage.model || e.model
    const spent =
      (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)

    if (!agentId) {
      await update($, bar, prev =>
        prev ? { ...prev, model, steps: prev.steps + 1, tokens: prev.tokens + spent, costUsd: prev.costUsd + costOf(model, usage) } : prev,
      )
      return result
    }
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens: spent,
              contextMax: windowOf(model),
              tokens: a.tokens + spent,
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const at = await $.clock.now()
    if (agentId) {
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens + e.usage.output_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
          }
        }),
      )
    } else {
      await update($, bar, prev => (prev ? { ...prev, isTurnOver: true } : prev))
    }
    await update($, now, () => at)
    await settle($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const b = await read($, bar)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const items = b?.items ?? []
    const t = totals(b, list, at)
    const title = b?.title ?? ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? 'Expand' : 'Collapse'}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && items.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} tokens, ${fmtTime(t.time)}`
    const planHead = `Plan · ${items.filter(i => i.status === 'completed').length}/${items.length}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, t)} alt={`${list.length} agents, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
          {toggleCompact}
          {isEmpty && <Text dimColor>No subagents yet.</Text>}
          {items.length > 0 && section('h-plan', planHead)}
          {items.map(i => (
            <Text key={`plan-${i.id}`} dimColor={i.status === 'completed'}>
              {itemText(i)}
            </Text>
          ))}
          {running.length > 0 && section('h-run', `Running · ${running.length}`)}
          {running.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, running`} width={W} height={66} />
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, finished`} width={W} height={66} />
            ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const color = colorOf(costumeOf(a.type, a.model))
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {a.type} · {metaOf(a).replace(/ {2}/g, ' ')}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} tokens · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(costumeOf(a.type, a.model))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>No subagents yet.</Text>}
            {items.length > 0 && <Text dimColor>{planHead}</Text>}
            {items.map(i => (
              <Text key={`plan-${i.id}`} dimColor={i.status === 'completed'} wrap="truncate-end">
                {itemText(i)}
              </Text>
            ))}
            {items.length > 0 && <Text> </Text>}
            {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, bar)
    if (b === null || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const running = list.filter(a => a.status === 'running').length
    const at = Math.max(await read($, now), b.startedAt)
    const text = label(b, running)
    const side = b.items.length ? `${Math.round(ratio(b) * 100)}%` : fmtTime(barElapsed(b, at))
    const color = b.isFinished ? DONE : ACCENT
    const crewButton = <Button key="zero-agents" label={`×${list.length}`} plain onPress={() => void togglePane($)} />
    const dismiss = <Button key="zero-dismiss" label="✕" plain role="dismiss" onPress={() => update($, bar, () => null)} />

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(b, width, running, at)} alt={`${headline(b)}: ${text}, ${side}`} width={width} height={H} />
          {list.length > 0 && crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const head = headline(b)
    const titleW = Math.max(8, Math.min(30, head.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="row" gap={2}>
        <Box width={titleW} flexShrink={0}>
          <Text color={color}>● </Text>
          <Text wrap="truncate-end">{head}</Text>
        </Box>
        <Text color={color}>{barText(b, width, at)}</Text>
        <Text bold>{text}</Text>
        <Text dimColor>{side}</Text>
        {list.length > 0 && <Text color={CLAY}>▣</Text>}
        {list.length > 0 && crewButton}
        {dismiss}
      </Box>
    )
  })
}
