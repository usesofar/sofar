import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { guardMatches, parseGuard, type DecisionCheck } from '@sofar/schema'
import type { TestOutcome, TimedTestOutcome } from './adjacency'
import { testShapedCommand } from './derived'
import { commonGitDir } from './git'
import { scopeHitsForSubject, type GuardIndex } from './index-tier1'
import { byCodeUnit } from './order'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * Decision checks (memory-lead 2.3, D9) — the executable half of a rule.
 *
 * A guard says which files a rule governs and warns when work crosses it. A
 * check says how to TELL whether the rule still holds: a shell command whose
 * exit 0 means it does, and a hint for when it does not. Round 1's research
 * behind it: harness engineering puts the remediation in the lint message, so
 * the fix lands in the agent's context at the moment of failure; and agents
 * edit tests to pass them (ImpossibleBench), so the command lives in the
 * append-only record, and its script is surfaced on read like any file the
 * decision names.
 *
 * WHEN IT BLOCKS (the user's rulings, D9 and memory-lead D37, qualifying
 * drift-hardening D3): at Stop through the test gate below, which runs nothing
 * itself (`SOFAR_ENFORCE=off` restores D10, where failures only ride the
 * write-back block); at pre-commit only when the operator opted in; and at
 * `sofar drive`'s task acceptance, because an unattended run has no one to
 * read a warning. Everywhere else it warns.
 *
 * WHETHER IT RUNS AT ALL. A check is text an agent wrote into a record that
 * travels with branches and teammates. Run from a Stop or git hook it would
 * execute on the operator's machine outside every permission prompt the host
 * has, so it runs only once the operator approved that exact command on this
 * clone (`sofar check --approve`, on a terminal) — or, under drive, when the
 * run's permission surface covers it (r1-fixes D19's rule for agent-written
 * commands). The approval lives in the state dir, per clone, never in the
 * repo: a merged branch cannot approve its own command.
 */

/** One in-force check, repo-wide, as the scope tier holds it. */
export interface InForceCheck {
  /** `<slug> D<n>`. */
  handle: string
  initiative: string
  ordinal: number
  rule: string
  quote?: string
  guard?: string
  check: DecisionCheck
}

/**
 * Every in-force decision check in the repo (D9): ruled scope-tier entries
 * carrying `check` that no later rule of their own record replaced. A check
 * never outlives its rule. By initiative, then ordinal.
 */
export function checksInForce(index: GuardIndex): InForceCheck[] {
  const out: InForceCheck[] = []
  for (const d of index.scoped) {
    if (d.check === undefined || d.rule === undefined || d.superseded_by !== undefined) continue
    out.push({
      handle: `${d.initiative} D${d.ordinal}`,
      initiative: d.initiative,
      ordinal: d.ordinal,
      rule: d.rule,
      ...(d.quote !== undefined ? { quote: d.quote } : {}),
      ...(d.guard !== undefined ? { guard: d.guard } : {}),
      check: d.check,
    })
  }
  return out.sort((a, b) => (a.initiative === b.initiative ? a.ordinal - b.ordinal : byCodeUnit(a.initiative, b.initiative)))
}

/**
 * The checks that bear on these changed paths (D9): a check whose decision
 * has a `path:` guard applies when the guard matches one of them; one with no
 * path guard (none, or a `cmd:` guard) applies to any change. With no changed
 * paths nothing applies — there is nothing new to check.
 */
export function applicableChecks(checks: readonly InForceCheck[], paths: readonly string[]): InForceCheck[] {
  if (paths.length === 0) return []
  return checks.filter((c) => {
    const guard = c.guard === undefined ? null : parseGuard(c.guard)
    if (guard === null || guard.domain !== 'path') return true
    return paths.some((p) => guardMatches(guard, p))
  })
}

/**
 * Paths the working tree changed against HEAD, untracked ones included, the
 * record excluded — what `git status` reports, in ONE spawn (the Stop gate's
 * cost, speed T2). Null without git.
 */
export function worktreeChanges(rootDir: string, pathspecs: readonly string[] | null = null): string[] | null {
  const scope = pathspecs === null ? [] : ['--', ...pathspecs]
  const out = git(rootDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', ...scope])
  if (out === null) return null
  const paths: string[] = []
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue
    const path = entry.slice(3)
    if (!path.startsWith(RECORD)) paths.push(path)
  }
  return paths
}

/**
 * A git glob pathspec covering every path one sofar path glob or file token
 * matches (r3-fixes D26), or null when git's glob cannot be trusted to: git
 * reads `[…]` as a class and a `**` inside a segment as `*`, both narrower
 * than a guard. A guard matches by tail at a `/` boundary, so the spec does
 * too, behind a leading `**` segment.
 */
function globSpec(glob: string): string | null {
  const g = glob.endsWith('/') ? `${glob}**` : glob
  if (g.length === 0 || g.startsWith('/') || /[[\]\\]/.test(g) || g.includes(':')) return null
  for (let i = g.indexOf('**'); i >= 0; i = g.indexOf('**', i + 2)) {
    if ((i > 0 && g[i - 1] !== '/') || (i + 2 < g.length && g[i + 2] !== '/')) return null
  }
  return g === '**' || g.startsWith('**/') ? `:(glob)${g}` : `:(glob)**/${g}`
}

/**
 * The pathspecs Stop's git question is scoped to (r3-fixes D26): every
 * positive guard glob and file mention of an in-force rule. Null — the whole
 * tree — when one of them cannot be expressed safely or when there are none
 * to scope by, so a scoped answer is never narrower than the gate's own match.
 */
export function gatePathspecs(index: GuardIndex): string[] | null {
  const specs = new Set<string>()
  for (const d of index.scoped) {
    if (d.rule === undefined || d.superseded_by !== undefined) continue
    if (d.guard !== undefined) {
      const g = parseGuard(d.guard)
      if (g !== null && g.domain === 'path') {
        for (const p of g.patterns) {
          if (p.negated) continue
          const spec = globSpec(p.source)
          if (spec === null) return null
          specs.add(spec)
        }
      }
    }
    for (const token of d.mentions) {
      const spec = globSpec(token)
      if (spec === null) return null
      specs.add(spec)
    }
  }
  return specs.size === 0 ? null : [...specs].sort(byCodeUnit)
}

/** Whether any in-force rule could bear on a path: one with a guard or a file mention. */
export function rulesCanBear(index: GuardIndex): boolean {
  return index.scoped.some((d) => d.rule !== undefined && d.superseded_by === undefined && (d.guard !== undefined || d.mentions.length > 0))
}

/** The record directory, a git-changed path outside it, and nothing else. */
const RECORD = '.sofar/'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/**
 * Paths the work changed, relative to the repo top, the record excluded: the
 * index (`staged`), or the working tree against HEAD plus untracked files.
 * Null without git.
 */
export function changedPaths(rootDir: string, mode: 'staged' | 'worktree'): string[] | null {
  const split = (out: string): string[] => out.split('\0').filter((p) => p.length > 0 && !p.startsWith(RECORD))
  if (mode === 'staged') {
    const staged = git(rootDir, ['diff', '--cached', '--name-only', '-z'])
    return staged === null ? null : split(staged)
  }
  const tracked = git(rootDir, ['diff', '--name-only', '-z', 'HEAD']) ?? git(rootDir, ['diff', '--cached', '--name-only', '-z'])
  const untracked = git(rootDir, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name'])
  if (tracked === null || untracked === null) return null
  return [...new Set([...split(tracked), ...split(untracked)])]
}

// ---------------------------------------------------------------------------
// Trust: what the operator approved on this clone, and whether commits block.
// ---------------------------------------------------------------------------

interface TrustFile {
  version: 1
  /** sha256(cmd) → what was approved, and when. */
  approved: Record<string, { handle: string; cmd: string; ts: string }>
  /** The pre-commit opt-in (D9): a failed approved check fails the commit. */
  block_commits?: boolean
}

/**
 * `<state>/checks/<key>.json`, keyed by the clone's COMMON git dir so every
 * worktree of one clone shares its approvals; null when the state dir would
 * sit inside the clone (self-improve D3) — then nothing is trusted.
 */
export function trustPath(rootDir: string, env: StateEnv = process.env): string | null {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) return null
  return join(base, 'checks', `${cloneKey(commonGitDir(rootDir) ?? rootDir)}.json`)
}

function readTrust(path: string | null): TrustFile {
  const empty: TrustFile = { version: 1, approved: {} }
  if (path === null || !existsSync(path)) return empty
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrustFile> | null
    if (decoded === null || typeof decoded !== 'object' || typeof decoded.approved !== 'object' || decoded.approved === null) return empty
    return { version: 1, approved: decoded.approved, ...(decoded.block_commits === true ? { block_commits: true } : {}) }
  } catch {
    return empty // an unreadable file approves nothing
  }
}

function writeTrust(path: string, trust: TrustFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(trust, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** sha256 of the command exactly as recorded: a changed command is a new command. */
export function checkDigest(cmd: string): string {
  return createHash('sha256').update(cmd).digest('hex')
}

/** Whether the operator approved this exact command on this clone. */
export function isApproved(rootDir: string, cmd: string, env: StateEnv = process.env): boolean {
  return readTrust(trustPath(rootDir, env)).approved[checkDigest(cmd)] !== undefined
}

/** Record the operator's approval of one check's command. Throws when there is no state dir to hold it. */
export function approveCheck(rootDir: string, check: InForceCheck, now: string, env: StateEnv = process.env): void {
  const path = trustPath(rootDir, env)
  if (path === null) throw new Error('the sofar state dir resolves inside this clone — set XDG_STATE_HOME elsewhere to approve checks')
  const trust = readTrust(path)
  trust.approved[checkDigest(check.check.cmd)] = { handle: check.handle, cmd: check.check.cmd, ts: now }
  writeTrust(path, trust)
}

/** The pre-commit opt-in (D9). Default false: an unreadable file is not consent. */
export function blocksCommits(rootDir: string, env: StateEnv = process.env): boolean {
  return readTrust(trustPath(rootDir, env)).block_commits === true
}

export function setBlocksCommits(rootDir: string, on: boolean, env: StateEnv = process.env): void {
  const path = trustPath(rootDir, env)
  if (path === null) throw new Error('the sofar state dir resolves inside this clone — set XDG_STATE_HOME elsewhere')
  const trust = readTrust(path)
  if (on) trust.block_commits = true
  else delete trust.block_commits
  writeTrust(path, trust)
}

// ---------------------------------------------------------------------------
// Running and reporting.
// ---------------------------------------------------------------------------

/** How one check ended — the shape driver/verify's runner returns. */
export interface CheckOutcome {
  result: 'pass' | 'fail' | 'timeout' | 'error' | 'refused'
  exit_code?: number
  signal?: string
  duration_ms: number
  diagnostics?: string
}

/** How a non-passing outcome ended, in a few words. */
export function describeOutcome(outcome: CheckOutcome): string {
  if (outcome.result === 'timeout') return `timed out after ${Math.round(outcome.duration_ms / 1000)}s`
  if (outcome.result === 'error') return 'could not run'
  if (outcome.result === 'refused') return 'refused — not approved on this clone and not inside the run\'s permission surface'
  if (outcome.exit_code !== undefined) return `exit ${outcome.exit_code}`
  if (outcome.signal !== undefined) return `killed by ${outcome.signal}`
  return outcome.result === 'pass' ? 'passed' : 'failed'
}

function lastLine(text: string | undefined): string | undefined {
  return text
    ?.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop()
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The failure line every surface prints (D9): which decision, how it ended,
 * the last thing the command said, the rule, and the fix. The hint is the
 * author's remediation; without one, the operator's quote (or the rule) is
 * what to restore, and superseding is the other way out.
 */
export function checkFailureLine(check: InForceCheck, outcome: CheckOutcome): string {
  const last = lastLine(outcome.diagnostics)
  const fix = check.check.hint !== undefined
    ? flat(check.check.hint)
    : `make the work hold the rule${check.quote !== undefined ? ` (the operator: "${flat(check.quote)}")` : ''}, or log a decision that supersedes ${check.handle}`
  return `sofar: check for [${check.handle}] failed (${describeOutcome(outcome)})${last !== undefined ? `: ${last}` : ''} — rule: "${flat(check.rule)}" — fix: ${fix}`
}

/** The line naming checks that bear on the work but that nothing approved (D9). */
export function unapprovedLine(checks: readonly InForceCheck[]): string | null {
  if (checks.length === 0) return null
  const named = checks.slice(0, 3).map((c) => `[${c.handle}] \`${c.check.cmd}\``).join(', ')
  const more = checks.length > 3 ? `, +${checks.length - 3} more` : ''
  return `sofar: ${checks.length} decision check(s) bear on this work but are not approved on this clone, so none ran: ${named}${more} — the operator approves one with \`sofar check --approve "<handle>"\``
}

/** Default per-check bound when the decision sets none (D9). */
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000

export interface CheckRun {
  check: InForceCheck
  outcome: CheckOutcome
}

/**
 * Run the approved checks among `checks`, within an optional total budget:
 * each runs for min(its timeout, per-check cap, what the budget has left),
 * and once the budget is spent the rest are `skipped` rather than run.
 * `run` is driver/verify's runVerification, injected so core runs nothing of
 * its own accord.
 */
export function runChecks(
  checks: readonly InForceCheck[],
  cwd: string,
  run: (cmd: string, cwd: string, timeoutMs: number) => CheckOutcome,
  limits: { perCheckMs?: number; budgetMs?: number } = {},
): { ran: CheckRun[]; skipped: InForceCheck[] } {
  const ran: CheckRun[] = []
  const skipped: InForceCheck[] = []
  let left = limits.budgetMs ?? Number.POSITIVE_INFINITY
  for (const check of checks) {
    const bound = Math.min(check.check.timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS, limits.perCheckMs ?? Number.POSITIVE_INFINITY, left)
    if (bound < 1_000) {
      skipped.push(check)
      continue
    }
    const outcome = run(check.check.cmd, cwd, bound)
    ran.push({ check, outcome })
    left -= outcome.duration_ms
  }
  return { ran, skipped }
}

// ---------------------------------------------------------------------------
// The Stop gate (r3-fixes 2.10, D10; memory-lead D37): sofar executes nothing.
// ---------------------------------------------------------------------------

/** Env switch: `SOFAR_ENFORCE=off` (also `0`, `false`) restores D10's Stop — the ablation arm. */
export const ENFORCE_ENV = 'SOFAR_ENFORCE'

export function enforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ENFORCE_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** At most this many gate lines ride one Stop; the rest are counted. */
export const STOP_GATE_LINES = 5

/** What a path names on disk: a directory or a file. */
export type PathKind = 'dir' | 'file'

/**
 * What a repo-relative (or absolute) path names on disk, or null for
 * nothing: the gate's one window on the tree (r4-fixes 0.2, U1).
 */
export type PathProbe = (path: string) => PathKind | null

/** No tree: every bare word reads as part of the runner, as for `suiteOf`, which projections call. */
const NO_TREE: PathProbe = () => null

/** The tree under `rootDir`, each path asked once. */
export function rootProbe(rootDir: string): PathProbe {
  const seen = new Map<string, PathKind | null>()
  return (path) => {
    let kind = seen.get(path)
    if (kind === undefined) {
      try {
        kind = statSync(isAbsolute(path) ? path : join(rootDir, path)).isDirectory() ? 'dir' : 'file'
      } catch {
        kind = null
      }
      seen.set(path, kind)
    }
    return kind
  }
}

/** A path a test command names: as written, normalized, and whether it is a directory. */
interface Operand {
  token: string
  path: string
  dir: boolean
}

/** A test segment split into its runner head and its arguments, and what the arguments select. */
interface TestSpec {
  head: string
  args: string[]
  /** The files and directories the arguments name; a directory selects everything under it. */
  operands: Operand[]
  /** A word that names no path (a positional filter, a flag's value, a quoted word): the run may select less than its paths. */
  narrowed: boolean
  /** A test-name filter flag: the run selects tests by name. */
  filtered: boolean
}

const ARG_TOKEN = /[/.=]|^-|^['"]/
/** A shell redirection: `2>&1`, `>out`, `&>log`, `<in`; a bare operator also takes the next token. */
const REDIRECT = /^(?:\d*|&)(?:>>?|<)(?:&\d+|.*)$/

/**
 * Words that stay in the runner even when a path of that name exists: every
 * runner, and a subcommand right after the word that takes it. So `bun test`
 * is a runner in a repo with a `test/` directory, while `pytest test` runs
 * that directory.
 */
const RUNNER_WORDS = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'py.test', 'rspec', 'phpunit', 'cypress', 'playwright', 'node'])
const SUBCOMMANDS = new Set([
  'npm test', 'npm t', 'npm run', 'pnpm test', 'pnpm t', 'pnpm run', 'yarn test', 'yarn t', 'yarn run', 'bun test', 'bun t', 'bun run',
  'run test', 'run t', 'poetry run', 'uv run', 'bundle exec', 'vitest run', 'cypress run', 'playwright test',
  'cargo test', 'go test', 'dotnet test', 'swift test', 'mix test', 'gradle test', 'gradlew test', 'mvn test', 'make test', 'deno test', 'zig test',
])
const keepsHead = (prev: string, word: string): boolean => RUNNER_WORDS.has(word) || SUBCOMMANDS.has(`${prev} ${word}`)

/** Test-name filters (go's `-run` among them): a run that selects tests by name covers only its own command. */
const FILTER_FLAGS = ['-t', '--testNamePattern', '--test-name-pattern', '-k', '--grep', '-g', '--filter', '-run']
const filterFlag = (token: string): string | undefined => FILTER_FLAGS.find((f) => token === f || token.startsWith(`${f}=`))

const quoted = (token: string): boolean => token.startsWith("'") || token.startsWith('"')

/** Just past the quoted word starting at `i`: the whitespace split cuts a quoted filter into tokens. */
function pastQuote(args: readonly string[], i: number): number {
  const q = args[i]![0]!
  if (args[i]!.length > 1 && args[i]!.endsWith(q)) return i + 1
  let j = i + 1
  while (j < args.length && !args[j]!.endsWith(q)) j += 1
  return Math.min(j + 1, args.length)
}

/** A path with `.` and empty segments dropped and `..` folded: `./tests/` is `tests`, and `''` is the root. */
function normalPath(token: string): string {
  const out: string[] = []
  for (const seg of token.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return `${token.startsWith('/') ? '/' : ''}${out.join('/')}`
}

/**
 * The path an argument names: one that exists, or a path-shaped one taken as
 * a file; go's `./...` is the directory before it. Null for a word that names
 * no path.
 */
function operandOf(token: string, probe: PathProbe): Operand | null {
  const recursive = token === '...' || token.endsWith('/...')
  const path = normalPath(recursive ? token.slice(0, -3) : token)
  const kind = path === '' ? 'dir' : probe(path)
  if (kind === 'dir' || (kind === 'file' && !recursive)) return { token, path, dir: kind === 'dir' }
  return /[/.]/.test(token) ? { token, path: normalPath(token), dir: false } : null
}

/**
 * The runner and its arguments: the head is every token up to the first that
 * reads as an argument — a path, a file, a flag, an assignment or a quoted
 * filter, or a bare word naming a path that exists (r4-fixes U1; not a runner
 * word, see `keepsHead`) — so `bun test test/a.test.ts` and `bun test tests`
 * are both `bun test` plus one argument. Redirections are not part of what
 * runs: `bun run test 2>&1` is `bun run test` (round-3 replay). Without a
 * tree (`NO_TREE`) a bare word stays in the head.
 */
function testSpec(segment: string, probe: PathProbe = NO_TREE): TestSpec {
  const raw = segment.trim().split(/\s+/).filter((t) => t.length > 0)
  const tokens: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i]!
    if (!REDIRECT.test(t)) tokens.push(t)
    else if (/^(?:\d*|&)(?:>>?|<)$/.test(t)) i += 1 // `> file`: the target goes too
  }
  const at = tokens.findIndex((t, i) => ARG_TOKEN.test(t) || (i > 0 && !keepsHead(tokens[i - 1]!, t) && probe(t) !== null))
  const spec: TestSpec = {
    head: (at === -1 ? tokens : tokens.slice(0, at)).join(' '),
    args: at === -1 ? [] : tokens.slice(at),
    operands: [],
    narrowed: false,
    filtered: false,
  }
  const args = spec.args
  for (let i = 0; i < args.length; ) {
    const t = args[i]!
    if (quoted(t)) {
      spec.narrowed = true
      i = pastQuote(args, i)
      continue
    }
    const filter = filterFlag(t)
    i += 1
    if (filter !== undefined) {
      spec.filtered = true
      if (t === filter && i < args.length) i = quoted(args[i]!) ? pastQuote(args, i) : i + 1 // its pattern
      continue
    }
    if (t.startsWith('-')) continue // a flag
    const operand = t.includes('=') ? null : operandOf(t, probe)
    if (operand === null) spec.narrowed = true
    else spec.operands.push(operand)
  }
  return spec
}

/** The runner a test command names, its arguments dropped: the suite an ask names (r3-fixes D10, D19). Reads no tree. */
export function suiteOf(cmd: string): string {
  return testSpec(cmd).head
}

const under = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`)

/**
 * Whether a run covers a requirement (r3-fixes D10; r4-fixes U1). The same
 * runner, and:
 * - an argless run covers every ask on its runner;
 * - a run naming every argument the requirement names covers it;
 * - a test-name filter voids the rest: such a run covers only its own command;
 * - otherwise a run's directories cover the paths under them and its files
 *   themselves, and a run with a directory covers an ask that names no path
 *   (the suite). A sibling path never covers, nor a run narrowed by a word
 *   that names no path.
 * Whether it PASSED, and after the last edit, is the gate's to ask.
 */
function covers(run: TestSpec, req: TestSpec): boolean {
  if (run.head !== req.head) return false
  if (run.args.length === 0) return true
  const named = req.args.length > 0 && req.args.every((a) => run.args.includes(a))
  if (run.filtered) return named && run.args.every((a) => req.args.includes(a))
  if (named) return true
  if (run.narrowed || run.operands.length === 0) return false
  if (req.operands.length === 0) return run.operands.some((o) => o.dir)
  return req.operands.every((t) => run.operands.some((o) => (o.dir ? under(t.path, o.path) : t.path === o.path)))
}

interface GateRule {
  handle: string
  rule: string
  hint?: string
}

/** One requirement the gate checks, and the rules that hang on it. */
interface Requirement {
  spec: TestSpec
  /** What the ask line tells the agent to run. */
  cmd: string
  rules: GateRule[]
}

export interface StopGate {
  /** Ask and failure lines, at most STOP_GATE_LINES plus a count line. */
  lines: string[]
  /** Whether Stop holds the session for them. */
  blocks: boolean
}

const flatClip = (text: string, max: number): string => {
  const f = flat(text)
  return f.length > max ? `${f.slice(0, max - 1)}…` : f
}

function namedRules(rules: readonly GateRule[]): string {
  const shown = rules.slice(0, 3).map((r) => `[${r.handle}] "${flatClip(r.rule, 140)}"`)
  return `${shown.join('; ')}${rules.length > 3 ? `; +${rules.length - 3} more` : ''}`
}

/**
 * One command for every ask on one runner (r4-fixes U1): a lone ask's own;
 * else the runner on the directory holding every path the asks name, or the
 * bare runner when one asks for the suite or the paths share no directory.
 */
function askCommand(head: string, reqs: readonly Requirement[], probe: PathProbe): string {
  if (reqs.length === 1) return reqs[0]!.cmd
  let common: string[] | null = null
  for (const req of reqs) {
    if (req.spec.operands.length === 0) return head
    for (const o of req.spec.operands) {
      const segs = o.path.split('/')
      const dir = o.dir ? segs : segs.slice(0, -1)
      if (common === null) common = dir
      else {
        let n = 0
        while (n < common.length && n < dir.length && common[n] === dir[n]) n += 1
        common = common.slice(0, n)
      }
    }
  }
  const dir = (common ?? []).join('/')
  return dir.length > 0 && probe(dir) === 'dir' ? `${head} ${dir}` : head
}

/**
 * The gate (r3-fixes D10): every in-force rule, repo-wide, that guards or names a path
 * this session edited needs a covering test that passed AFTER the session's
 * last edit — its check's test segment, or for a rule without a test-shaped
 * check the repo's suite (the runner of `knownTest`, the record's newest test
 * command, on the directories it ran). A failed latest covering run is a
 * failure line, one per run; no covering run is an ask, one line per runner
 * (r4-fixes U1). With no known suite, an unchecked rule asks nothing: sofar
 * never demands tests a repo does not have. Pure but for `probe`: the caller
 * hands it the index, the session's files, its tests since the last edit, and
 * the tree the commands' paths name.
 */
export function stopGate(
  index: GuardIndex,
  files: readonly string[],
  testsSinceEdit: readonly TimedTestOutcome[],
  knownTest: string | null,
  editedAtMs: number | null = null,
  probe: PathProbe = NO_TREE,
): StopGate {
  // A run counts only if it finished after the newest edit on disk: edits the
  // hooks never saw (Bash writes, lost captures) void earlier runs too.
  const runs = editedAtMs === null ? testsSinceEdit : testsSinceEdit.filter((r) => Date.parse(r.ts) > editedAtMs)
  const bearing = new Map<string, (typeof index.scoped)[number]>()
  for (const path of files) {
    if (path.startsWith('+')) continue // the overflow sentinel, not a path
    for (const hit of scopeHitsForSubject(index, 'path', path)) {
      const d = hit.decision
      if (d.rule === undefined || d.superseded_by !== undefined) continue
      bearing.set(d.id, d)
    }
  }
  if (bearing.size === 0) return { lines: [], blocks: false }

  // The suite: the known command's runner on the directories it ran, never its files or filters.
  const known = knownTest === null ? null : testSpec(knownTest, probe)
  const suiteDirs = known === null || known.operands.some((o) => o.dir && o.path === '') ? [] : known.operands.filter((o) => o.dir)
  const reqs = new Map<string, Requirement>()
  const ordered = [...bearing.values()].sort((a, b) =>
    a.initiative === b.initiative ? a.ordinal - b.ordinal : byCodeUnit(a.initiative, b.initiative),
  )
  for (const d of ordered) {
    const own = d.check === undefined ? null : testShapedCommand(d.check.cmd)
    let spec: TestSpec
    let cmd: string
    if (own !== null) {
      spec = testSpec(own, probe)
      cmd = d.check!.cmd
    } else if (known !== null && known.head.length > 0) {
      const args = suiteDirs.map((o) => o.token)
      spec = { head: known.head, args, operands: suiteDirs, narrowed: false, filtered: false }
      cmd = [known.head, ...args].join(' ')
    } else continue
    const key = `${spec.head}\0${[...spec.args].sort(byCodeUnit).join('\0')}`
    const req = reqs.get(key) ?? { spec, cmd, rules: [] }
    req.rules.push({
      handle: `${d.initiative} D${d.ordinal}`,
      rule: d.rule!,
      ...(d.check?.hint !== undefined ? { hint: d.check.hint } : {}),
    })
    reqs.set(key, req)
  }

  // Asks on one runner fold into one line with one command; requirements a
  // failed run covers, into that run's line.
  const ran = runs.map((run) => ({ run, spec: testSpec(run.cmd, probe) }))
  const groups = new Map<string, { head: string; failed?: TestOutcome; reqs: Requirement[] }>()
  for (const [key, req] of reqs) {
    let at = ran.length - 1
    while (at >= 0 && !covers(ran[at]!.spec, req.spec)) at -= 1
    const latest = at >= 0 ? ran[at]!.run : undefined
    if (latest?.ok === true) continue
    const group = latest !== undefined ? `failed\0${at}` : req.spec.head.length > 0 ? `ask\0${req.spec.head}` : `ask\0\0${key}`
    const into = groups.get(group) ?? { head: req.spec.head, ...(latest !== undefined ? { failed: latest } : {}), reqs: [] }
    into.reqs.push(req)
    groups.set(group, into)
  }
  const lines: string[] = []
  for (const group of groups.values()) {
    const rules = group.reqs.flatMap((r) => r.rules)
    const hint = rules.find((r) => r.hint !== undefined)?.hint
    const fix = hint !== undefined ? flat(hint) : 'make the work hold the rule, or log a decision that supersedes it'
    const failed = group.failed
    lines.push(
      failed === undefined
        ? `sofar: ${namedRules(rules)} bear on files you edited, and no covering test passed since your last edit — run \`${askCommand(group.head, group.reqs, probe)}\` and fix any failure before stopping (fix: ${fix})`
        : `sofar: \`${failed.cmd}\` failed${failed.exit !== undefined ? ` (exit ${failed.exit})` : ''} after your last edit, and it covers ${namedRules(rules)} — fix: ${fix}`,
    )
  }
  const shown = lines.slice(0, STOP_GATE_LINES)
  if (lines.length > STOP_GATE_LINES) shown.push(`sofar: +${lines.length - STOP_GATE_LINES} more test requirement(s) bear on this session's edits — \`sofar check\` lists the rules`)
  return { lines: shown, blocks: lines.length > 0 }
}
