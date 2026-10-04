import { resolveHandle } from '../core/handle'
import type { InitiativeState } from '../core/fold'
import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar show <id…>` (memory-lead 4.3, part D; D25) — one entry of the record,
 * whole, by its handle: `D12` (or `D12·k3fz`), `M3`, `brief`, `brief¶4`.
 *
 * The recall block and the digest point here instead of at a whole file: in
 * round 3 an agent that wanted one decision's words ran `cat decisions.md`
 * and paid for 117k chars to read 1k (R3-FIX-SURVEY part A, section 0), and 32 greps
 * of events.jsonl hunted decision ids. This prints what the fold holds for the
 * handles asked, and nothing else.
 */
export function runShow(rootDir: string, ids: readonly string[], options: { initiative?: string } = {}): CmdResult {
  const ctx = createToolContext(rootDir)
  let slug: string
  let state: InitiativeState
  try {
    slug = ctx.resolveWriteInitiative(options.initiative)
    state = ctx.foldState(slug)
  } catch (err) {
    return fail(`sofar show: ${err instanceof ToolError ? err.message : errMessage(err)}\n`)
  }
  const out: string[] = []
  const missing: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    const text = showOne(state, id)
    if (text === null) missing.push(id)
    else out.push(text)
  }
  const body = out.length > 0 ? `${out.join('\n\n')}\n` : ''
  if (missing.length === 0) return ok(body)
  return { exitCode: 1, stdout: body, stderr: `sofar show: ${slug} has no ${missing.join(', ')} — handles look like D12, M3, brief or brief¶4\n` }
}

function showOne(state: InitiativeState, id: string): string | null {
  if (/^D[1-9]/i.test(id)) {
    const which = resolveHandle(state.decisions, id)
    if (which === null || !which.ok) return null
    const d = state.decisions[which.ordinal - 1]
    if (d === undefined) return null
    const lines = [`D${which.ordinal} — ${d.ts.slice(0, 10)}${d.superseded_by !== undefined ? ` — replaced by D${d.superseded_by}` : ''}`]
    if (d.rule !== undefined) lines.push(`rule: ${d.rule}`)
    if (d.quote !== undefined) lines.push(`quote: ${d.quote}`)
    lines.push(`chose: ${d.chose}`, `over: ${d.over}`, `because: ${d.because}`)
    if (d.guard !== undefined) lines.push(`guard: ${d.guard}`)
    if (d.check !== undefined) lines.push(`check: ${d.check.cmd}`)
    if (d.supersedes !== undefined) lines.push(`supersedes: ${d.supersedes}`)
    if (d.until !== undefined) lines.push(`until: ${d.until}`)
    return lines.join('\n')
  }
  const memory = /^M([1-9][0-9]*)$/i.exec(id)
  if (memory !== null) {
    const m = state.memories[Number(memory[1]) - 1]
    if (m === undefined) return null
    return `M${memory[1]} — ${m.ts.slice(0, 10)}${m.superseded_by !== undefined ? ` — replaced by ${m.superseded_by}` : ''}\n${m.text}`
  }
  const paragraphs = state.brief
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (id === 'brief') return paragraphs.length > 0 ? paragraphs.map((p, i) => `brief¶${i + 1}\n${p}`).join('\n\n') : null
  const brief = /^(?:brief)?¶([1-9][0-9]*)$/.exec(id)
  if (brief !== null) {
    const p = paragraphs[Number(brief[1]) - 1]
    return p === undefined ? null : `brief¶${brief[1]}\n${p}`
  }
  return null
}
