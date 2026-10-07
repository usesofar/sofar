import { existsSync, mkdirSync } from 'node:fs'
import { createToolContext, currentBranch, initiativeSlugs, ToolError, type ToolContext } from '../mcp/context'
import { applyClose } from '../mcp/close-initiative'
import { declareWaitsOn } from '../mcp/waits-on'
import { BindingsAbort, writeBinding } from '../core/bindings'
import { forgetLastHome } from '../core/last-home'
import { QUICK_LANE } from '../core/lane'
import { lexicalCounts, rankLexical, type LexicalDoc } from '../core/lexicon'
import { clip } from '../projections/templates/shared'
import { isClosedInitiativeStatus } from '@sofar/schema'
import { SLUG_RE } from '@sofar/schema/tool-inputs'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'

/**
 * `sofar new <slug> [--goal <text>]` / `sofar switch <slug>` (task 4.2,
 * SPEC §CLI) — create/select an initiative and bind the current branch to it
 * in .sofar/bindings.json.
 *
 * new: creates .sofar/initiatives/<slug>/, appends initiative_created
 * (source 'cli', actor 'human' — the human is directing the CLI), binds the
 * branch (unless --no-bind), regenerates projections. switch: rebinds the
 * branch to an EXISTING initiative. Neither ever creates a log for a typo:
 * slugs are validated, and switch refuses unknown slugs.
 */

// One home for the slug shape (packages/schema/src): it is a validation rule,
// and it is now load-bearing for path safety, so it must not be able to drift
// between the CLI that creates slugs and the tool layer that accepts them.
export { SLUG_RE }

/** Non-empty goal required by the initiative_created schema when --goal is omitted. */
export const DEFAULT_GOAL = '(goal not recorded yet — set one with sofar_update_plan)'

const NO_BRANCH_HINT =
  'not inside a git repo (or HEAD is detached), so there is no branch to bind'

/** CLI-created events carry the human directing the CLI (BD26). */
export const CLI_ACTOR = { session: 'cli', source: 'cli', actor: 'human' } as const

export interface NewOptions {
  goal?: string
  /** commander --no-bind → bind: false; default true. */
  bind?: boolean
  /**
   * --supersedes <a>,<b>: records this one continues (initiative-supersession
   * 2.3). Each is checked BEFORE anything is created, then closed as
   * `superseded` by the new slug after it exists — one ordinary close per
   * predecessor, so the log reads exactly as if they had been run by hand.
   */
  supersedes?: string[]
  /**
   * --waits-on <handles> (linked-context 2.3, D11): what the new record waits
   * on. Declared links live on a TASK and a new record has none, so the set
   * seeds the plan's first task, `1.1 Wait on …`, in `Phase 1` — the umbrella
   * shape SPEC §Links names. Checked before anything is created.
   */
  waitsOn?: string[]
}

/** The phase and task `--waits-on` seeds (D11). */
export const WAITS_ON_SEED_PHASE = 'Phase 1'
export const WAITS_ON_SEED_TASK = '1.1'

// ---------------------------------------------------------------------------
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, and the dim └ detail rail — so piped
// output stays byte-identical to the unstyled report. Failure text lands on
// stderr, so it styles under the STDERR stream's caps (errCaps): a stdout
// TTY must not push escapes into a redirected stderr.
// ---------------------------------------------------------------------------

export function renderConfirmation(report: string[], caps: Caps): string {
  const [result = '', ...details] = report
  if (!caps.color) return report.join('\n')
  const style = createStyle(true)
  const symbols = symbolsFor(caps.unicode)
  return [
    `${style.success(symbols.ok)} ${result}`,
    ...details.map((line) => style.dim(`  ${symbols.elbow} ${line}`)),
  ].join('\n')
}

export function renderFailure(message: string, caps: Caps): string {
  if (!caps.color) return message
  return `${createStyle(true).error(symbolsFor(caps.unicode).fail)} ${message}`
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

export function runNew(
  rootDir: string,
  slug: string,
  options: NewOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  if (!SLUG_RE.test(slug)) {
    return fail(
      renderFailure(
        `sofar new: invalid slug "${slug}" — slugs are lowercase letters, digits, and hyphens only ([a-z0-9-]+)`,
        errCaps,
      ),
    )
  }

  // The quick lane creates itself (r1-fixes 2.6, D14): it is the record an
  // unbound branch falls back to, not one a branch is made for.
  if (slug === QUICK_LANE) {
    return fail(
      renderFailure(
        `sofar new: "${QUICK_LANE}" is the quick-work lane — it creates itself on the first edit of an unbound branch; give project work its own slug`,
        errCaps,
      ),
    )
  }

  const ctx = createToolContext(rootDir)
  if (existsSync(ctx.initiativeDir(slug))) {
    return fail(
      renderFailure(
        `sofar new: initiative "${slug}" already exists — use \`sofar switch ${slug}\` to bind this branch to it`,
        errCaps,
      ),
    )
  }

  // Every predecessor is checked BEFORE anything is created, for the same
  // reason as the branch below: a refusal must leave the repo untouched.
  const supersedes = [...new Set((options.supersedes ?? []).map((s) => s.trim()).filter((s) => s.length > 0))]
  for (const predecessor of supersedes) {
    if (!SLUG_RE.test(predecessor)) {
      return fail(
        renderFailure(
          `sofar new: --supersedes "${predecessor}" is not a slug — lowercase letters, digits, and hyphens only ([a-z0-9-]+)`,
          errCaps,
        ),
      )
    }
    if (predecessor === slug) {
      return fail(renderFailure(`sofar new: "${slug}" cannot supersede itself`, errCaps))
    }
    if (!existsSync(ctx.initiativeDir(predecessor))) {
      return fail(
        renderFailure(
          `sofar new: --supersedes "${predecessor}" not found under .sofar/initiatives/ — nothing created`,
          errCaps,
        ),
      )
    }
  }

  // Same rule for declared links: an unknown slug refuses the whole command.
  let waits: { handles: string[]; warnings: string[] } | undefined
  if (options.waitsOn !== undefined) {
    const raw = options.waitsOn.map((s) => s.trim()).filter((s) => s.length > 0)
    try {
      const declared = declareWaitsOn(ctx, slug, { tasks: new Set([WAITS_ON_SEED_TASK]), waits: new Map() }, [
        { taskId: WAITS_ON_SEED_TASK, raw },
      ])
      waits = { handles: declared.handles[0]!, warnings: declared.warnings }
    } catch (err) {
      if (err instanceof ToolError) return fail(renderFailure(`sofar new: --waits-on: ${(err.errors ?? [err.message]).join('; ')} — nothing created`, errCaps))
      throw err
    }
    if (waits.handles.length === 0) return fail(renderFailure('sofar new: --waits-on names no handle — nothing created', errCaps))
  }

  // Resolve the branch BEFORE creating anything, so a bind failure leaves
  // the repo untouched.
  const bind = options.bind !== false
  const branch = bind ? currentBranch(rootDir) : null
  if (bind && branch === null) {
    return fail(
      renderFailure(
        `sofar new: ${NO_BRANCH_HINT} — re-run with --no-bind and add the binding to .sofar/bindings.json yourself`,
        errCaps,
      ),
    )
  }

  const goal = options.goal !== undefined && options.goal.trim().length > 0
    ? options.goal.trim()
    : DEFAULT_GOAL

  const report: string[] = []
  try {
    mkdirSync(ctx.initiativeDir(slug), { recursive: true })
    ctx.appendAndProject(slug, 'initiative_created', { slug, goal }, {
      session: 'cli',
      source: 'cli',
      actor: 'human',
    })
    report.push(`created .sofar/initiatives/${slug}/ (goal: ${goal})`)
    if (waits !== undefined) {
      const task = { id: WAITS_ON_SEED_TASK, title: `Wait on ${waits.handles.join(', ')}`, waits_on: waits.handles }
      ctx.appendAndProject(slug, 'plan_updated', { plan: { phases: [{ name: WAITS_ON_SEED_PHASE, tasks: [task] }] } }, CLI_ACTOR)
      report.push(`task ${task.id} waits on ${waits.handles.join(', ')}`)
      for (const warning of waits.warnings) report.push(`warning: ${warning}`)
    }
    for (const line of similarRecords(ctx, slug, goal, supersedes)) report.push(line)
    if (bind && branch !== null) {
      mkdirSync(ctx.sofarDir, { recursive: true })
      writeBinding(ctx.bindingsPath, branch, slug)
      // An explicit route beats a remembered one (r4-fixes A10).
      forgetLastHome(ctx.sofarDir, { branch })
      report.push(`bound branch "${branch}" → ${slug}`)
    }
    // Bind first, close second: closing unbinds every branch on a
    // predecessor (initiative-lifecycle D1), and this branch has already
    // moved to the new record, so the order leaves it pointing at live work.
    for (const predecessor of supersedes) {
      const { unbound, overrides } = applyClose(ctx, predecessor, 'superseded', undefined, slug, CLI_ACTOR)
      report.push(
        `closed ${predecessor} as superseded by ${slug}` +
          (unbound.length > 0 ? ` (unbound ${unbound.map((b) => `"${b}"`).join(', ')})` : ''),
      )
      if (overrides.length > 0) {
        report.push(`  ${predecessor} closed with ${overrides.length} finding(s) OVERRIDDEN — recorded on the event:`)
        for (const finding of overrides) report.push(`    ${finding}`)
      }
    }
  } catch (err) {
    if (err instanceof BindingsAbort || err instanceof ToolError) {
      return fail(renderFailure(`sofar new: ${errMessage(err)}`, errCaps))
    }
    throw err
  }
  return ok(`${renderConfirmation(report, caps)}\n`)
}

/** How many existing records `sofar new` offers (linked-context 5.3). */
export const SIMILAR_CAP = 3

/**
 * The open records whose goal reads most like the new one's, by BM25 over
 * goals (linked-context 5.3) — offered so related work is LINKED rather than
 * duplicated or nested (D5). Nothing when no goal was given; the records the
 * new one supersedes and the quick lane are not offered.
 */
function similarRecords(ctx: ToolContext, slug: string, goal: string, supersedes: readonly string[]): string[] {
  if (goal === DEFAULT_GOAL) return []
  const goals = new Map<string, string>()
  const docs: LexicalDoc[] = []
  for (const s of initiativeSlugs(ctx.sofarDir)) {
    if (s === slug || s === QUICK_LANE || supersedes.includes(s)) continue
    const state = ctx.foldState(s)
    if (isClosedInitiativeStatus(state.status) || state.goal === DEFAULT_GOAL) continue
    const terms = lexicalCounts(state.goal)
    goals.set(s, state.goal)
    docs.push({ id: s, ts: '', terms, tokens: Object.values(terms).reduce((a, b) => a + b, 0) })
  }
  const matches = rankLexical(docs, goal, SIMILAR_CAP).matches.filter((m) => m.score > 0)
  if (matches.length === 0) return []
  return [
    ...matches.map((m) => `similar goal: ${m.id} — ${clip(goals.get(m.id)!, 80)}`),
    `if this work waits on one, declare it on a task: waits_on ["${matches[0]!.id}"]`,
  ]
}

export function runSwitch(
  rootDir: string,
  slug: string,
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const ctx = createToolContext(rootDir)
  if (!existsSync(ctx.initiativeDir(slug))) {
    return fail(
      renderFailure(
        `sofar switch: initiative "${slug}" not found under .sofar/initiatives/ — create it with \`sofar new ${slug}\``,
        errCaps,
      ),
    )
  }

  const branch = currentBranch(rootDir)
  if (branch === null) {
    return fail(
      renderFailure(
        `sofar switch: ${NO_BRANCH_HINT} — add the binding to .sofar/bindings.json yourself`,
        errCaps,
      ),
    )
  }

  try {
    mkdirSync(ctx.sofarDir, { recursive: true })
    const report: string[] = []

    // Reopen-on-switch (D3): switching a branch onto a record IS the act of
    // working on it again, which is what revives it — so a closed slug is
    // never a dead end here. Never silent, though: the revival is announced
    // and appended, so the log shows closed-then-reopened rather than an
    // unexplained return to active. Appended BEFORE the bind, so a failure
    // cannot leave a branch pointing at a record still marked closed.
    const state = ctx.foldState(slug)
    if (isClosedInitiativeStatus(state.status)) {
      ctx.appendAndProject(slug, 'initiative_status_changed', { status: 'active' }, {
        session: 'cli',
        source: 'cli',
        actor: 'human',
      })
      report.push(`reopened ${slug} (was ${state.status}) — working on it again is what revives it`)
    }

    // An explicit route beats a remembered one (r4-fixes A10): forgetting
    // this worktree's last home for the branch is part of the switch, so a
    // switch onto the committed binding it already names still takes effect.
    const forgot = forgetLastHome(ctx.sofarDir, { branch }) > 0
    const changed = writeBinding(ctx.bindingsPath, branch, slug) || forgot
    report.push(
      changed
        ? `bound branch "${branch}" → ${slug}`
        : `branch "${branch}" already bound to ${slug} — nothing to do`,
    )
    return ok(`${renderConfirmation(report, caps)}\n`)
  } catch (err) {
    if (err instanceof BindingsAbort || err instanceof ToolError) {
      return fail(renderFailure(`sofar switch: ${errMessage(err)}`, errCaps))
    }
    throw err
  }
}
