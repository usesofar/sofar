/**
 * Derived activity (r1-fixes 2.5, D24): the outcome facts the record already
 * holds — command_run `ok`/`exit` (self-improve D2) — folded into what a
 * session and a task can be said to have done, plus the one env switch that
 * removes the derived lines from the injected surfaces for round 3's
 * ablation arm. Nothing here reads the clock, the filesystem or the store:
 * the fold stays a pure function of the log (5.1 purity), and the switch is
 * read only by the CLI and the MCP server, never by a projection.
 */

/** Env switch: `SOFAR_ACTIVITY=off` (also `0`, `false`) — round 3's ablation arm (D24 (5)). */
export const ACTIVITY_ENV = 'SOFAR_ACTIVITY'

export function activityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ACTIVITY_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/**
 * Sentences appended to two tool descriptions while derived activity is on
 * (D24 (4)): the one place the MCP dialect is told what NOT to write. Under
 * the switch they go too, so the ablation arm removes the telling with the
 * showing.
 */
export const ACTIVITY_GUIDANCE: Readonly<Record<string, string>> = {
  sofar_update_task:
    ' The note is WHY — files, commands, test outcomes and commits are captured by hooks and derived; never restate them.',
  sofar_end_session:
    ' The summary is WHY and what it means — files, commands, test outcomes and commits are derived from the record.',
}

export function withActivityGuidance(name: string, description: string, env: NodeJS.ProcessEnv = process.env): string {
  const extra = ACTIVITY_GUIDANCE[name]
  return extra === undefined || !activityEnabled(env) ? description : `${description}${extra}`
}

/** Bound on the command text a test outcome keeps. */
export const TEST_CMD_CLIP = 120

const PKG_TEST = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::[\w-]+)?(?:\s|$)/
const RUNNER =
  /^(?:(?:npx|pnpm|yarn|bun|bunx|poetry\s+run|uv\s+run|bundle\s+exec)\s+)?(?:vitest|jest|mocha|ava|tap|pytest|py\.test|rspec|phpunit|cypress\s+run|playwright\s+test|node\s+--test)(?:\s|$)/
const TOOL_TEST = /^(?:cargo|go|dotnet|swift|mix|gradle|\.\/gradlew|gradlew|mvn|make|deno|zig)\s+test(?:\s|$)/
const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/

/**
 * The first shell segment of `cmd` that runs a test suite, or null. Pure and
 * total: a CLOSED set of runners matched at the head of each `&&`, `||`, `;`,
 * `|` or newline segment, after leading `VAR=value` assignments are dropped —
 * so `cd pkg && npm test` and `CI=1 vitest run` are test commands, and
 * `git commit -m "npm test"` is not (quoted text is never a segment head).
 * What the command DID is `ok`, never this: an unknown outcome stays unknown.
 */
export function testShapedCommand(cmd: string): string | null {
  for (const raw of splitSegments(cmd)) {
    const seg = raw.replace(ENV_ASSIGN, '').trim()
    if (seg.length === 0) continue
    if (PKG_TEST.test(seg) || RUNNER.test(seg) || TOOL_TEST.test(seg)) return seg.slice(0, TEST_CMD_CLIP)
  }
  return null
}

/** Quote-aware split on the shell's sequencing operators — inside quotes an `&&` is text. */
function splitSegments(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!
    if (quote !== null) {
      cur += ch
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') {
        cur += cmd[i + 1] ?? ''
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '\\') {
      cur += ch + (cmd[i + 1] ?? '')
      i += 1
    } else if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) {
      out.push(cur)
      cur = ''
      i += 1
    } else if (ch === ';' || ch === '|' || ch === '\n') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Heads that cannot write a file whatever their arguments (r3-fixes 2.13,
 * D23, D24). An allowlist, so it fails safe: every head not here marks the
 * session. Not `awk` (its program can print to a file), not `env`, `xargs`,
 * `time` or `sudo` (they run another command), not `xxd` or `file` (`xxd in
 * out`, `file -C`), not `node`/`python` (scripts).
 */
const READ_ONLY_HEADS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'wc', 'cut', 'tr', 'diff',
  'cmp', 'stat', 'du', 'df', 'pwd', 'which', 'type', 'echo', 'printf', 'true', 'false', 'date', 'whoami', 'uname',
  'jq', 'cd', 'sleep', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'od', 'hexdump', 'md5',
  'md5sum', 'shasum', 'sha256sum',
])

/** Heads that write only through one option, which marks: `sort -o`, `tree -o`. */
const OUTPUT_OPTION_HEADS = new Set(['sort', 'tree'])

/** git subcommands that leave working-tree files alone; any other one may write (`checkout`, `apply`, `lfs pull`…). */
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files', 'ls-tree', 'grep', 'describe', 'shortlog',
  'reflog', 'cat-file', 'merge-base', 'rev-list', 'name-rev', 'for-each-ref', 'show-ref', 'show-branch',
  'range-diff', 'whatchanged', 'cherry', 'check-ignore', 'count-objects', 'var', 'help', 'version', 'branch', 'tag',
  'remote', 'config', 'fetch', 'add', 'commit', 'push', 'notes',
])

/** sofar subcommands that write nothing outside `.sofar/`; `init`, `check`, `export`, `drive`… may. */
const SOFAR_READ_ONLY = new Set([
  'status', 'list', 'next', 'why', 'related', 'find', 'doctor', 'new', 'switch', 'close', 'remember', 'bind',
  'supersedes', 'event', 'review', 'statusline',
])

/** Find's actions that delete, run or write. */
const FIND_WRITERS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])

/** A test run that rewrites what it checks: `-u`, `--update`, `--update-snapshots`, `--updateSnapshot`, `--write`. */
const TEST_WRITE_FLAG = /^(?:-u|--update(?:-?snapshots?|Snapshot)?|--write)(?:=.*)?$/

/** `w` and `e` sed commands: they write a file or run one. Matched loosely, which only over-marks. */
const SED_WRITE = /(?:^|[\s/;}'"])[we](?:\s|['"]|$)/

/** Command or process substitution, outside single quotes: it runs whatever it holds. */
function substitutes(cmd: string): boolean {
  let single = false
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!
    if (ch === "'") single = !single
    else if (single) continue
    else if (ch === '\\') i += 1
    else if (ch === '`') return true
    else if ((ch === '$' || ch === '<' || ch === '>') && cmd[i + 1] === '(') return true
  }
  return false
}

/** Output redirection to anything but /dev/null, /dev/stdout or /dev/stderr, outside quotes; `2>&1` and `>&2` are not. */
function redirectsToFile(cmd: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch !== '>') continue
    let j = i + 1
    if (cmd[j] === '>' || cmd[j] === '|') j += 1
    if (cmd[j] === '&') continue // a descriptor copy: 2>&1, >&2
    while (cmd[j] === ' ' || cmd[j] === '\t') j += 1
    let k = j
    while (k < cmd.length && !/[\s;&|()<>]/.test(cmd[k]!)) k += 1
    const target = cmd.slice(j, k)
    if (target !== '/dev/null' && target !== '/dev/stdout' && target !== '/dev/stderr') return true
    i = k - 1
  }
  return false
}

/** A segment that reads only: an allowlisted head, or git, sofar, find, sed, sort, tree or uniq doing nothing that writes. */
function readOnlySegment(seg: string): boolean {
  const tokens = seg.split(/\s+/).filter((t) => t.length > 0)
  const head = tokens[0] ?? ''
  const args = tokens.slice(1)
  if (head === 'git') {
    let i = 1
    while (i < tokens.length && tokens[i]!.startsWith('-')) i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1
    return i >= tokens.length || GIT_READ_ONLY.has(tokens[i]!)
  }
  if (head === 'sofar') return args.length === 0 || SOFAR_READ_ONLY.has(args[0]!)
  if (head === 'find') return !args.some((t) => FIND_WRITERS.has(t))
  if (head === 'sed') return !args.some((t) => t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place=')) && !SED_WRITE.test(seg.slice(3))
  if (OUTPUT_OPTION_HEADS.has(head)) return !args.some((t) => t.startsWith('-o') || t.startsWith('--output'))
  // `uniq in out` writes out: two operands mark.
  if (head === 'uniq') return args.filter((t) => !t.startsWith('-')).length <= 1
  return READ_ONLY_HEADS.has(head)
}

/**
 * Whether a shell command may write a file the hooks never capture (r3-fixes
 * 2.13, D23, D24): the one reason Stop's test gate asks git. FAILS SAFE: false
 * only when every segment is a test run that updates nothing or an
 * allowlisted read, nothing redirects output to a file, and nothing
 * substitutes a command. Any command it does not recognise may write. A false
 * mark costs one git spawn at Stop; a missed one would skip the gate (R4-A).
 */
export function mayWriteCommand(cmd: string): boolean {
  if (redirectsToFile(cmd) || substitutes(cmd)) return true
  for (const raw of splitSegments(cmd)) {
    const seg = raw.replace(ENV_ASSIGN, '').trim()
    if (seg.length === 0) continue
    if (PKG_TEST.test(seg) || RUNNER.test(seg) || TOOL_TEST.test(seg)) {
      if (seg.split(/\s+/).some((t) => TEST_WRITE_FLAG.test(t))) return true
      continue
    }
    if (!readOnlySegment(seg)) return true
  }
  return false
}
