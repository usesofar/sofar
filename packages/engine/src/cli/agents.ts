import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { AGENTS, type AgentId } from './agent-ids'
import { type Caps, createStyle, symbolsFor } from './ui'

/**
 * The agents `sofar init` sets up, and how it asks which (r1-fixes 7.1, D35,
 * D36). Installers for agent skills and plugins ask which coding agents to
 * install for, and a Cursor-only or Codex-only project should not carry
 * files for an agent it never runs, so init asks too.
 *
 * Which files belong to which agent is init's business (init.ts); this module
 * holds the ids, the `--agents` grammar, what the machine has installed, and
 * the terminal picker. Nothing here writes a file.
 */

/** Picker order, and the order `--agents all` expands to. */
export { AGENTS, type AgentId } from './agent-ids'

export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
}

/** What init writes for each agent, shown beside it in the picker. */
export const AGENT_FILES: Readonly<Record<AgentId, string>> = {
  'claude-code': '.claude/, .mcp.json, CLAUDE.md',
  cursor: '.cursor/, AGENTS.md',
  codex: '.codex/, AGENTS.md',
}

function isAgentId(value: string): value is AgentId {
  return (AGENTS as readonly string[]).includes(value)
}

/** The same ids in picker order, each once. */
export function orderAgents(agents: Iterable<AgentId>): AgentId[] {
  const set = new Set(agents)
  return AGENTS.filter((id) => set.has(id))
}

/**
 * Parse `--agents`: `all`, or a comma-separated list of ids. Returns the ids
 * in picker order, or the error to print — an unknown name is refused rather
 * than skipped, so a typo cannot silently set up less than was asked for.
 */
export function parseAgents(value: string): { agents: AgentId[] } | { error: string } {
  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
  const choices = `${AGENTS.join(', ')}, or all`
  if (names.length === 0) return { error: `--agents needs at least one agent: ${choices}` }
  if (names.includes('all')) return { agents: [...AGENTS] }
  const unknown = names.find((name) => !isAgentId(name))
  if (unknown !== undefined) return { error: `unknown agent "${unknown}" — choose from ${choices}` }
  return { agents: orderAgents(names as AgentId[]) }
}

// ---------------------------------------------------------------------------
// What this machine has.
// ---------------------------------------------------------------------------

/** An agent counts as installed when its binary is on PATH or its home config directory exists. */
const MACHINE_SIGNS: Readonly<Record<AgentId, { bins: readonly string[]; dir: string }>> = {
  'claude-code': { bins: ['claude'], dir: '.claude' },
  cursor: { bins: ['cursor-agent', 'cursor'], dir: '.cursor' },
  codex: { bins: ['codex'], dir: '.codex' },
}

export interface MachineProbe {
  env?: Record<string, string | undefined>
  home?: string
  platform?: string
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function onPath(bin: string, probe: MachineProbe): boolean {
  const env = probe.env ?? process.env
  const exts = (probe.platform ?? process.platform) === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    if (exts.some((ext) => existsSync(join(dir, bin + ext)))) return true
  }
  return false
}

/** Agents installed on this machine, in picker order. A file probe only — nothing is spawned. */
export function agentsOnMachine(probe: MachineProbe = {}): AgentId[] {
  const home = probe.home ?? homedir()
  return AGENTS.filter((id) => {
    const sign = MACHINE_SIGNS[id]
    return isDir(join(home, sign.dir)) || sign.bins.some((bin) => onPath(bin, probe))
  })
}

// ---------------------------------------------------------------------------
// The picker: a pure state machine, a renderer, and a thin keypress loop.
// ---------------------------------------------------------------------------

export interface PickerState {
  /** Row under the pointer. */
  row: number
  selected: ReadonlySet<AgentId>
  /** Agents on this machine or already wired in the repo — marked in the list. */
  found: ReadonlySet<AgentId>
  /** One-line complaint under the list, cleared by the next key. */
  notice?: string
  done?: 'confirmed' | 'cancelled'
}

export type PickerKey = 'up' | 'down' | 'toggle' | 'all' | 'confirm' | 'cancel'

export function initialPickerState(preselected: Iterable<AgentId>, found: Iterable<AgentId>): PickerState {
  return { row: 0, selected: new Set(preselected), found: new Set(found) }
}

/** Map a readline keypress to a picker action; null for keys the picker ignores. */
export function pickerKey(str: string | undefined, key: { name?: string; ctrl?: boolean } = {}): PickerKey | null {
  if (key.ctrl === true && (key.name === 'c' || key.name === 'd')) return 'cancel'
  switch (key.name) {
    case 'up':
    case 'k':
      return 'up'
    case 'down':
    case 'j':
      return 'down'
    case 'space':
      return 'toggle'
    case 'return':
    case 'enter':
      return 'confirm'
    case 'escape':
      return 'cancel'
    case 'a':
      return 'all'
  }
  return str === ' ' ? 'toggle' : null
}

export function reducePicker(state: PickerState, key: PickerKey): PickerState {
  if (state.done !== undefined) return state
  const { notice: _cleared, ...rest } = state
  switch (key) {
    case 'up':
      return { ...rest, row: (state.row + AGENTS.length - 1) % AGENTS.length }
    case 'down':
      return { ...rest, row: (state.row + 1) % AGENTS.length }
    case 'toggle': {
      const id = AGENTS[state.row]!
      const selected = new Set(state.selected)
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      return { ...rest, selected }
    }
    case 'all':
      // One keystroke selects every agent; a second clears them, the way
      // checkbox installers toggle all.
      return {
        ...rest,
        selected: state.selected.size === AGENTS.length ? new Set<AgentId>() : new Set(AGENTS),
      }
    case 'confirm':
      return state.selected.size === 0
        ? { ...rest, notice: 'select at least one agent (space toggles, a selects all)' }
        : { ...rest, done: 'confirmed' }
    case 'cancel':
      return { ...rest, done: 'cancelled' }
  }
}

export const PICKER_QUESTION = 'Set up sofar for which agents?'

/** The list while picking; one summary line once confirmed or cancelled. */
export function renderPicker(state: PickerState, caps: Caps): string {
  const style = createStyle(caps.color)
  const sym = symbolsFor(caps.unicode)
  if (state.done === 'confirmed') {
    const names = orderAgents(state.selected).map((id) => AGENT_LABELS[id])
    return `${style.success(sym.ok)} ${PICKER_QUESTION} ${style.bold(names.join(', '))}`
  }
  if (state.done === 'cancelled') return `${style.error(sym.fail)} ${PICKER_QUESTION} cancelled`

  const width = Math.max(...AGENTS.map((id) => AGENT_LABELS[id].length))
  const lines = [
    `${style.info('?')} ${style.bold(PICKER_QUESTION)} ${style.dim('space toggles · a all · enter confirms')}`,
  ]
  AGENTS.forEach((id, i) => {
    const here = i === state.row
    const box = state.selected.has(id) ? sym.boxDone : sym.boxPending
    const label = AGENT_LABELS[id].padEnd(width)
    const found = state.found.has(id) ? `  ${style.success('found')}` : ''
    lines.push(
      `${here ? style.accent(sym.pointer) : ' '} ${box} ${here ? style.bold(label) : label}  ${style.dim(AGENT_FILES[id])}${found}`,
    )
  })
  if (state.notice !== undefined) lines.push(`  ${style.warn(state.notice)}`)
  return lines.join('\n')
}

export interface PickerInput extends NodeJS.EventEmitter {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
  resume(): unknown
  pause(): unknown
}

export interface PickerOutput {
  write(chunk: string): unknown
}

/**
 * Ask on the terminal. Resolves the picked agents in picker order, or null
 * when the operator cancels (esc, ctrl-c, or the input closing). Draws on the
 * output stream — stderr in production, so init's report on stdout stays
 * byte-identical to a flagged run.
 */
export function pickAgents(
  preselected: readonly AgentId[],
  found: readonly AgentId[],
  input: PickerInput,
  output: PickerOutput,
  caps: Caps,
): Promise<AgentId[] | null> {
  return new Promise((resolve) => {
    let state = initialPickerState(preselected, found)
    let drawn = 0
    const raw = input.isTTY === true && typeof input.setRawMode === 'function'

    const draw = (): void => {
      const text = renderPicker(state, caps)
      // Back to the top of the last frame, then clear everything below it.
      const rewind = drawn > 0 ? `\x1b[${drawn}A\r\x1b[0J` : ''
      output.write(`${rewind}${text}\n`)
      drawn = text.split('\n').length
    }

    const finish = (): void => {
      input.off('keypress', onKey)
      input.off('end', onEnd)
      if (raw) input.setRawMode?.(false)
      input.pause()
      draw()
      output.write('\x1b[?25h')
      resolve(state.done === 'confirmed' ? orderAgents(state.selected) : null)
    }

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      const action = pickerKey(str, key)
      if (action === null) return
      state = reducePicker(state, action)
      if (state.done !== undefined) finish()
      else draw()
    }

    const onEnd = (): void => {
      state = reducePicker(state, 'cancel')
      finish()
    }

    emitKeypressEvents(input as NodeJS.ReadableStream)
    if (raw) input.setRawMode?.(true)
    input.on('keypress', onKey)
    input.on('end', onEnd)
    input.resume()
    output.write('\x1b[?25l')
    draw()
  })
}
