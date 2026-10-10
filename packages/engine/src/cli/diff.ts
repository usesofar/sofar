import { codePointLabel, revealHidden } from '../core/hidden-chars'
import { commitOf, logsAtCommit, mergeBaseOf } from '../core/record-copies'
import { diffRecords, type RecordDelta, type RecordDiff } from '../core/record-diff'
import { fail, type CmdResult } from './shared'

/**
 * `sofar diff <base>..<head>` (r4-fixes B7) — what a branch changes in the
 * record, as Markdown for a pull request body or review comment: decisions
 * added and retired, checks bound, memories promoted, tasks resolved, and
 * three findings that need a reviewer — hidden characters, forks against
 * base, and rewritten history (core/record-diff.ts).
 *
 * It prints and never sends: posting it is the user's own `gh pr create
 * --body-file` or their own CI (E4). `--strict` exits 1 when a finding needs
 * a look, so a CI step can fail on one.
 */

export interface DiffOptions {
  strict?: boolean
}

interface Range {
  base: string
  head: string
}

/** `A..B`, `A...B` (the same here: see record-diff.ts), `A..`, `..B`, or `A` (head = HEAD). */
export function parseRange(range: string): Range | null {
  const m = /^(.*?)\.\.\.?(.*)$/.exec(range)
  if (m === null) return range.length > 0 ? { base: range, head: 'HEAD' } : null
  const base = m[1]!.length > 0 ? m[1]! : 'HEAD'
  const head = m[2]!.length > 0 ? m[2]! : 'HEAD'
  return { base, head }
}

/**
 * Record text in Markdown prose: hidden characters shown as `⟦U+XXXX⟧`, and
 * every character that could hide or restyle text when rendered escaped. An
 * HTML comment, a link reference definition or an entity like `&#8238;`
 * would otherwise vanish from, or reappear as a bidi control in, the
 * rendered PR body. Line breaks print as `↵` so the text stays in its bullet.
 */
export function md(text: string): string {
  return revealHidden(text)
    .replace(/[\\`*[\]<>&|~]/g, '\\$&')
    .replace(/\r\n?|\n/g, ' ↵ ')
}

/** A code span that holds any text: a fence longer than the longest backtick run inside. */
export function code(text: string): string {
  const body = revealHidden(text).replace(/\r\n?|\n/g, ' ↵ ')
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${body}${pad}${fence}`
}

const HIDDEN_LIST_CAP = 20
const SNIPPET = 160

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The revealed text around its first hidden character, at most SNIPPET code points. */
function snippet(text: string, firstAt: number): string {
  const cps = Array.from(text)
  if (cps.length <= SNIPPET) return text
  const start = Math.max(0, Math.min(firstAt - SNIPPET / 2, cps.length - SNIPPET))
  return `${start > 0 ? '…' : ''}${cps.slice(start, start + SNIPPET).join('')}${start + SNIPPET < cps.length ? '…' : ''}`
}

function renderRecord(r: RecordDelta): string[] {
  const out: string[] = [`### ${r.slug}${r.created ? ' (new record)' : ''}`, '']
  if (r.decisions.length > 0) {
    out.push(`**Decisions added (${r.decisions.length})**`)
    for (const { handle, decision: d, replaces } of r.decisions) {
      out.push(`- **${handle}** — ${md(d.chose)}`)
      if (d.rule !== undefined) out.push(`  - Rule: ${md(d.rule)}`)
      if (d.quote !== undefined) out.push(`  - Operator's words: ${md(d.quote)}`)
      if (d.guard !== undefined) {
        const was = replaces?.guard !== undefined && replaces.guard !== d.guard ? ` (was ${code(replaces.guard)})` : ''
        out.push(`  - Guard: ${code(d.guard)}${was}`)
      }
      if (d.check !== undefined) out.push(`  - Check: ${code(d.check.cmd)}`)
      if (replaces !== undefined) out.push(`  - Replaces ${replaces.handle}${replaces.rule !== undefined ? `: ${md(replaces.rule)}` : ''}`)
      else if (d.supersedes !== undefined) out.push(`  - Replaces ${md(d.supersedes)}`)
      if (d.until !== undefined) out.push(`  - Until task ${md(d.until)} resolves`)
      out.push(`  - Over: ${md(d.over)}`, `  - Because: ${md(d.because)}`)
    }
    out.push('')
  }
  if (r.removed.length > 0) {
    out.push(`**Decisions retired (${r.removed.length})**`)
    for (const { handle, decision: d, why } of r.removed) {
      const how =
        why.kind === 'superseded' ? `replaced by ${why.by}` : why.kind === 'until' ? `task ${md(why.task)} resolved` : 'voided by a correction'
      out.push(`- **${handle}** — ${how}: ${md(d.rule ?? d.chose)}`)
    }
    out.push('')
  }
  if (r.checks.length > 0) {
    out.push(`**Checks bound (${r.checks.length})**`)
    for (const c of r.checks) out.push(`- **${c.handle}** — ${code(c.cmd)}${c.was !== undefined ? ` (was ${code(c.was)})` : ''}`)
    out.push('')
  }
  if (r.memories.length > 0) {
    out.push(`**Memories (${r.memories.length})**`)
    for (const m of r.memories) out.push(`- **${m.handle}** — ${md(m.text)}${m.supersedes !== undefined ? ` (replaces ${md(m.supersedes)})` : ''}`)
    out.push('')
  }
  if (r.tasks.length > 0) {
    out.push(`**Tasks resolved (${r.tasks.length})**`)
    for (const t of r.tasks) out.push(`- ${md(t.id)} ${t.status} — ${md(t.title)}${t.note !== undefined ? `: ${md(t.note)}` : ''}`)
    out.push('')
  }
  if (r.hidden.length > 0) {
    out.push(`**⚠ Hidden characters (${r.hidden.length})**`)
    for (const h of r.hidden.slice(0, HIDDEN_LIST_CAP)) {
      const kinds = [...new Set(h.chars.map((c) => c.codePoint))].map(codePointLabel).join(', ')
      out.push(`- **${md(h.where)}** ${code(h.field)}: ${kinds} — ${md(snippet(h.text, h.chars[0]!.at))}`)
    }
    if (r.hidden.length > HIDDEN_LIST_CAP) out.push(`- +${r.hidden.length - HIDDEN_LIST_CAP} more`)
    out.push('')
  }
  if (r.forks.length > 0) {
    out.push(`**⚠ Forks against base (${r.forks.length})**`)
    for (const f of r.forks) {
      out.push(
        `- **${f.target}**${f.rule !== undefined ? ` (${md(f.rule)})` : ''} is replaced here by ${f.here.join(', ')} and on base by ${f.base.join(', ')}. Merged, both replacements stand: settle which one holds first.`,
      )
    }
    out.push('')
  }
  const { removed, edited } = r.rewrite
  if (removed.length + edited.length > 0) {
    const parts = [
      ...(edited.length > 0 ? [`${plural(edited.length, 'event')} edited in place (${edited.map(code).join(', ')})`] : []),
      ...(removed.length > 0 ? [`${plural(removed.length, 'event')} removed since the merge base (${removed.map(code).join(', ')})`] : []),
    ]
    out.push('**⚠ History rewritten**', `- ${parts.join('; ')}. The log is append-only: a correction is a new event.`, '')
  }
  return out
}

function summary(diff: RecordDiff): string {
  let decisions = 0
  let rules = 0
  let retired = 0
  let memories = 0
  let tasks = 0
  for (const r of diff.records) {
    decisions += r.decisions.length
    rules += r.decisions.filter((d) => d.decision.rule !== undefined).length
    retired += r.removed.length
    memories += r.memories.length
    tasks += r.tasks.length
  }
  const parts = [
    `${plural(decisions, 'decision')} added${rules > 0 ? ` (${plural(rules, 'rule')})` : ''}`,
    `${retired} retired`,
    `${plural(memories, 'memory', 'memories')}`,
    `${plural(tasks, 'task')} resolved`,
  ]
  return `${plural(diff.records.length, 'record')} changed: ${parts.join(', ')}.`
}

export function renderDiff(diff: RecordDiff, label: string): string {
  const out: string[] = [`## Record changes: ${label}`, '']
  if (diff.records.length === 0 && diff.deleted.length === 0) return `${out.concat('No record changes.').join('\n')}\n`
  out.push(summary(diff))
  out.push(
    diff.flagged > 0
      ? `⚠ ${plural(diff.flagged, 'finding')} below ${diff.flagged === 1 ? 'needs' : 'need'} a reviewer.`
      : 'No hidden characters, forks or rewritten history.',
  )
  const behind = diff.records.reduce((n, r) => n + r.behind, 0)
  if (behind > 0) out.push(`Base holds ${plural(behind, 'event')} this branch has not merged; forks are checked against them.`)
  out.push('')
  if (diff.deleted.length > 0) {
    out.push(`**⚠ Records deleted (${diff.deleted.length})**`, `- ${diff.deleted.map(md).join(', ')}: the merge base held them, and this branch removes them.`, '')
  }
  for (const r of diff.records) out.push(...renderRecord(r))
  while (out[out.length - 1] === '') out.pop()
  return `${out.join('\n')}\n`
}

export function runDiff(rootDir: string, range: string, options: DiffOptions = {}): CmdResult {
  const parsed = parseRange(range)
  if (parsed === null) return fail('sofar diff: name a range — `sofar diff <base>..<head>`, or `sofar diff <base>` for <base>..HEAD\n')
  const baseSha = commitOf(rootDir, parsed.base)
  if (baseSha === null) return fail(`sofar diff: ${parsed.base} names no commit in this repository\n`)
  const headSha = commitOf(rootDir, parsed.head)
  if (headSha === null) return fail(`sofar diff: ${parsed.head} names no commit in this repository\n`)
  const base = logsAtCommit(rootDir, baseSha)
  const head = logsAtCommit(rootDir, headSha)
  if (base === null || head === null) return fail('sofar diff: git could not read the record at those commits\n')
  const mergeSha = mergeBaseOf(rootDir, baseSha, headSha)
  const mergeBase = mergeSha === null ? new Map<string, string>() : (logsAtCommit(rootDir, mergeSha) ?? new Map<string, string>())
  const diff = diffRecords(base, head, mergeBase)
  const label = `${code(`${parsed.base}..${parsed.head}`)} (${baseSha.slice(0, 7)}..${headSha.slice(0, 7)})`
  return { exitCode: options.strict === true && diff.flagged > 0 ? 1 : 0, stdout: renderDiff(diff, label), stderr: '' }
}
