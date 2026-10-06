import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { version } from '../../package.json'
import { createSofarServer } from '../mcp/server'
import { registerCommitTrailerCommand } from './commit-trailer'
import { registerFoldCommand } from './fold'
import { registerEventCommand } from './event'
import { registerReviewCommand } from './review'
import { runAdopt } from './adopt'
import { runInitCommand } from './init'
import { stderrCaps } from './ui'
import { runAbandon } from './abandon'
import { explainCheck, runDoctor } from './doctor'
import { runUninit } from './uninit'
import { runNew, runSwitch } from './new'
import { runClose } from './close'
import { runStatus, runStatusWatch } from './status'
import { runList } from './list'
import { runNext } from './next'
import {
  detachedStartNotifier,
  runDrive,
  runDriveAwait,
  runDriveDetached,
  runDriveFollow,
  runDriveStop,
  runKeepAwakeSetting,
  terminalPrompt,
} from './drive'
import { runRelated, runWhy } from './graph'
import { runCheck } from './check'
import { COMPOSE_BUDGET, runCompose } from './compose'
import { runFind } from './find'
import { REACH_DEFAULT_HOPS, REACH_MAX_HOPS } from '../core/index-reach'
import { runRemember } from './remember'
import { runBind } from './bind'
import { runSupersedes } from './supersedes'
import { runShow } from './show'
import { runRead } from './read'
import { runNativeImport } from './native-import'
import { registerStatuslineCommand } from './statusline'
import { startServer, renderServeBanner, DEFAULT_PORT } from './serve'
import { runExport, runImport } from './transfer'
import { runDiagnostics } from './diagnostics'
import { runTune } from './tune'
import { runSuggest, runSuggestVerb } from './suggest'
import { runLogin, runLink, runPush, runPull, runPullWatch } from './cloud'
import { runUpgrade } from './upgrade'
import { runCheckStatus, runRefresh, withUpdateNotice } from './update-check'
import { writeAutoUpgrade } from './user-config'
import { emit, fail, ok, readAllStdin, readInput } from './shared'
import { recordRoot } from '../core/git'

const program = new Command()

program
  .name('sofar')
  .description('Sofar v1 engine — event-log initiative memory for coding agents')
  // Single-sourced from package.json (task 6.4, BD39) — esbuild inlines the
  // JSON import, so the bundle always carries the manifest's version.
  .version(version)
  // Registration only: the UI kernel (cli/ui/caps.ts) reads these straight
  // from process.argv, so commander merely has to accept them anywhere on
  // the line (SPEC §CLI UI, ladder). --no-color also defines the paired
  // opts.color default; the value is unused.
  .option('--color', 'force styled output, even piped')
  .option('--no-color', 'plain output, even on a TTY')

/** Every repo-scoped command takes --root (default: the record above the cwd, r3-fixes 2.12) — the mcp/event precedent. */
function rootOf(opts: { root?: string }): string {
  return resolve(opts.root ?? recordRoot(process.cwd()))
}

program
  .command('init')
  .description(
    'make this repo sofar-ready for the agents you pick: .sofar/ plus, per agent, hooks, MCP entry and protocol block — Claude Code (.claude/, .mcp.json, CLAUDE.md), Cursor (.cursor/, AGENTS.md), Codex (AGENTS.md) (idempotent)',
  )
  .option(
    '--agents <list>',
    'agents to set up: claude-code, cursor, codex (comma-separated) or all — default: the agents already wired here; on a first init, ask on a terminal and refuse otherwise',
  )
  .option(
    '--refresh',
    'rewire exactly the agents this repo is already wired for (protocol blocks, hook shims) — never asks, never adds an agent',
  )
  .option(
    '--statusline',
    'also wire `sofar statusline` as the project statusLine (merged only when settings.json has none — an existing statusLine is never touched)',
  )
  // --prompt-capture first, so commander leaves the value undefined when
  // neither is passed and a plain re-run changes nothing (r3-fixes 2.9, D6).
  .option('--prompt-capture', 'turn prompt capture back on for this clone')
  .option('--no-prompt-capture', "don't keep this clone's prompts in the private buffer that briefs are kept from by id")
  .option('--root <dir>', 'repo root (default: the git toplevel of the current directory, else the current directory)')
  .action(
    async (opts: { agents?: string; refresh?: boolean; statusline?: boolean; root?: string; promptCapture?: boolean }) => {
      const caps = stderrCaps()
      const result = await runInitCommand(opts, {
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        input: process.stdin,
        output: process.stderr,
        interactive: process.stdin.isTTY === true && caps.animate,
        caps,
      })
      emit(result.exitCode === 0 ? withUpdateNotice(result) : result)
    },
  )

program
  .command('uninit')
  .description(
    'exact inverse of init: remove hook shims, settings hook entries, the .mcp.json server entry, and the protocol blocks; .sofar/ is kept unless --purge',
  )
  .option('--purge', 'also delete the .sofar/ record (irreversible)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { purge?: boolean; root?: string }) => {
    emit(runUninit(rootOf(opts), { purge: opts.purge === true }))
  })

program
  .command('doctor')
  .description(
    'audit this repo: what to act on now (wiring, the hot path, record integrity, live sessions, tool hazards — the only findings that set the exit code), then one line counting the history; --history lists it, --fix writes each tool\'s .sofar exclusion',
  )
  .option(
    '--fix',
    'apply the safe fixes: insert `@source not "…/.sofar"` after the tailwindcss import; add the .sofar exclusion to biome.json, .prettierignore, .markdownlintignore',
  )
  .option('--history', 'also list the history: settled sessions, unnamed repo memory, past guard crossings, record hygiene')
  .option('--json', 'every finding as JSON, with its check id and tier')
  .option('--explain <id>', 'what one check looks at, why it matters, and how to clear it')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { fix?: boolean; history?: boolean; json?: boolean; explain?: string; root?: string }) => {
    if (opts.explain !== undefined) {
      emit(explainCheck(opts.explain))
      return
    }
    // withUpdateNotice touches stderr only — doctor's exit code is its verdict
    // on the RECORD, and a new release must never be able to change it (D1).
    const result = runDoctor(rootOf(opts), { fix: opts.fix === true, history: opts.history === true, json: opts.json === true })
    emit(opts.json === true ? result : withUpdateNotice(result))
  })

program
  .command('abandon [branch]')
  .description(
    "mark a branch abandoned on this clone: its record copies stop being named at SessionStart, in the write guard, `sofar status` and `sofar list` (r4-fixes A14); per-user state, the branch itself is untouched",
  )
  .option('--undo', 'clear the mark, so the branch is named again')
  .option('--list', 'list the branches marked abandoned (also the default with no branch)')
  .option('--root <dir>', 'repo root (default: the record above the current directory)')
  .action((branch: string | undefined, opts: { undo?: boolean; list?: boolean; root?: string }) => {
    emit(runAbandon(rootOf(opts), branch, { undo: opts.undo === true, list: opts.list === true }))
  })

program
  .command('new <slug>')
  .description('create an initiative and bind the current branch to it')
  .option('--goal <text>', 'initiative goal recorded in initiative_created')
  .option('--no-bind', 'skip binding the current branch in .sofar/bindings.json')
  .option(
    '--supersedes <slugs>',
    'comma-separated initiatives this one continues: each is closed as `superseded` by the new slug once it exists',
  )
  .option(
    '--waits-on <handles>',
    'comma-separated handles the new record waits on (`<slug>` or `<slug> D<n>|T<n>|<n>.<n>|M<n>`): seeds task 1.1 carrying them',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string, opts: { goal?: string; bind?: boolean; supersedes?: string; waitsOn?: string; root?: string }) => {
    emit(
      runNew(rootOf(opts), slug, {
        ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
        bind: opts.bind !== false,
        ...(opts.supersedes !== undefined ? { supersedes: opts.supersedes.split(',') } : {}),
        ...(opts.waitsOn !== undefined ? { waitsOn: opts.waitsOn.split(',') } : {}),
      }),
    )
  })

program
  .command('switch <slug>')
  .description('rebind the current branch to an existing initiative')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string, opts: { root?: string }) => {
    emit(runSwitch(rootOf(opts), slug))
  })

program
  .command('close [slug]')
  .description(
    'close an initiative: record it done (or --drop it, with a reason; or --superseded-by the record it continues in) and unbind every branch pointing at it',
  )
  .option('--drop', 'close as `dropped` (abandoned) rather than `done` — requires --reason')
  .option('--reason <text>', 'why it closed; REQUIRED for --drop')
  .option(
    '--superseded-by <slug>',
    'close as `superseded`: the work continues in <slug>, which must already exist — the pointer every surface then follows',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(
    (
      slug: string | undefined,
      opts: { drop?: boolean; reason?: string; supersededBy?: string; root?: string },
    ) => {
      emit(
        runClose(rootOf(opts), slug, {
          drop: opts.drop === true,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          ...(opts.supersededBy !== undefined ? { supersededBy: opts.supersededBy } : {}),
        }),
      )
    },
  )

program
  .command('adopt <legacy-file> [slug]')
  .description(
    'guided migration of a pre-sofar prose record: print the replay brief for an agent to execute; --mark stamps the legacy file superseded',
  )
  .option('--mark', 'prepend an idempotent SUPERSEDED banner to the legacy file')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((legacyFile: string, slug: string | undefined, opts: { mark?: boolean; root?: string }) => {
    emit(runAdopt(rootOf(opts), legacyFile, slug, { mark: opts.mark === true }))
  })

program
  .command('status [slug]')
  .description(
    'fold and print the initiative: goal, progress, phase tree, next action, blocked, last session — across every copy of the record on other worktrees and unmerged branches',
  )
  .option('--watch', "live status (TTY only; piped falls back to one shot): re-render on record changes, other copies' included, active tasks pulse, ^C to exit")
  .option('--here', "this checkout's copy of the record only, ignoring other worktrees and branches")
  .option('--remotes', 'also fold remote-tracking branches (origin/*)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(
    (
      slug: string | undefined,
      opts: { watch?: boolean; here?: boolean; remotes?: boolean; root?: string },
    ) => {
      const copies = { here: opts.here, remotes: opts.remotes }
      if (opts.watch === true) {
        const result = runStatusWatch(rootOf(opts), slug, undefined, copies)
        if (result !== undefined) emit(result) // non-TTY fallback / resolution failure
        return // live path: watcher + timer hold the process until ^C
      }
      emit(withUpdateNotice(runStatus(rootOf(opts), slug, undefined, undefined, copies)))
    },
  )

program
  .command('list')
  .description(
    'one line per initiative: slug, bound branch, progress, active phase, next action — most recently active first, folded across other worktrees and unmerged branches',
  )
  .option('--here', "this checkout's copy of the record only, ignoring other worktrees and branches")
  .option('--remotes', 'also fold remote-tracking branches (origin/*)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { here?: boolean; remotes?: boolean; root?: string }) => {
    emit(runList(rootOf(opts), undefined, undefined, { here: opts.here, remotes: opts.remotes }))
  })

program
  .command('next')
  .description(
    "every initiative's next action, one line each, most recently active first — entries with record drift since their last write-back flagged ⚠ may be stale; folded across other worktrees and unmerged branches",
  )
  .option('--here', "this checkout's copy of the record only, ignoring other worktrees and branches")
  .option('--remotes', 'also fold remote-tracking branches (origin/*)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { here?: boolean; remotes?: boolean; root?: string }) => {
    emit(runNext(rootOf(opts), undefined, undefined, { here: opts.here, remotes: opts.remotes }))
  })

program
  .command('why <path>')
  .description(
    'every task, session and decision behind a path, across ALL initiatives, newest-first — the cross-initiative provenance a single-log fold cannot see',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((path: string, opts: { root?: string }) => {
    emit(runWhy(rootOf(opts), path))
  })

program
  .command('check')
  .description(
    'run the decision checks that bear on your changes (memory-lead 2.3): each a command a ruled decision carries, run only once the operator approved it on this clone; warns, and fails a commit only when this clone opted in',
  )
  .option('--staged', 'check the staged paths — what the pre-commit hook runs; exits 10 only when this clone opted in and an approved check failed')
  .option('--all', 'run every approved check, whatever changed')
  .option('--strict', 'exit 1 when a check failed')
  .option('--list', 'list every in-force check and whether it is approved here; runs nothing')
  .option('--approve <handle>', 'approve one check\'s command on this clone ("<slug> D<n>") — asks on a terminal; an agent cannot approve its own command')
  .option('--block-commits <on|off>', 'make a failed approved check refuse commits on this clone (on), or only warn (off, the default)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { staged?: boolean; all?: boolean; strict?: boolean; list?: boolean; approve?: string; blockCommits?: string; root?: string }) => {
    // The approval is the operator's (memory-lead D9): asked only on a real
    // terminal, never under CI, never from a piped agent shell.
    const terminal = process.stdin.isTTY === true && process.stderr.isTTY === true && process.env.CI === undefined
    const confirm = terminal
      ? async (question: string): Promise<boolean> => {
          const { createInterface } = await import('node:readline/promises')
          const rl = createInterface({ input: process.stdin, output: process.stderr })
          try {
            return /^y(es)?$/i.test((await rl.question(question)).trim())
          } finally {
            rl.close()
          }
        }
      : null
    const { root, ...rest } = opts
    emit(await runCheck(rootOf({ ...(root !== undefined ? { root } : {}) }), rest, { confirm }))
  })

program
  .command('related <task-id>')
  .description(
    'tasks that worked on the same files as this one, ranked by shared paths — cross-initiative neighbours included; accepts <task-id>, <slug>#<task-id>, or "<slug> <task-id>"',
  )
  .option('--initiative <slug>', 'initiative the task id belongs to (default: the branch-bound one)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((taskId: string, opts: { initiative?: string; root?: string }) => {
    emit(runRelated(rootOf(opts), taskId, opts.initiative !== undefined ? { initiative: opts.initiative } : {}))
  })

program
  .command('find <seed>')
  .description(
    'traverse the record out from a seed — a path, a session id, an initiative slug, or a decision handle like "record-index D2" — and report what is within a hop budget, each row citing the event id behind its edge; adjacency, offered as worth reading, never a rule',
  )
  .option('--hops <n>', `how far to traverse (default ${REACH_DEFAULT_HOPS}, max ${REACH_MAX_HOPS})`)
  .option('--initiative <slug>', 'initiative a bare "D<n>" seed belongs to (default: the branch-bound one)')
  .option('--compose', 'answer packet: waits, citations, matches and adjacency as one budgeted list of id-cited lines, marking what changed since the last write-back')
  .option('--budget <chars>', `with --compose: whole-output budget in characters (default ${COMPOSE_BUDGET})`)
  .option('--since <when>', 'with --compose: event id or ISO timestamp to mark changes after (default: the last write-back of the branch-bound record)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(
    (
      seed: string,
      opts: { hops?: string; initiative?: string; compose?: boolean; budget?: string; since?: string; root?: string },
    ) => {
      const base = {
        ...(opts.hops !== undefined ? { hops: Number(opts.hops) } : {}),
        ...(opts.initiative !== undefined ? { initiative: opts.initiative } : {}),
      }
      if (opts.compose !== true && (opts.budget !== undefined || opts.since !== undefined)) {
        emit(fail('sofar find: --budget and --since need --compose'))
        return
      }
      emit(
        opts.compose === true
          ? runCompose(rootOf(opts), seed, {
              ...base,
              ...(opts.budget !== undefined ? { budget: Number(opts.budget) } : {}),
              ...(opts.since !== undefined ? { since: opts.since } : {}),
            })
          : runFind(rootOf(opts), seed, base),
      )
    },
  )

program
  .command('remember [text]')
  .description(
    'promote an operational fact to repo memory — a release command, a failure mode, a convention future sessions must know; recorded as <slug> M<n> for .sofar/repo.md to name. Text inline, `-` for stdin (quoted heredoc), or @<file>',
  )
  .option('--supersedes <handle>', 'the memory this fact replaces — `M<n>` in the target initiative or the qualified `<slug> M<n>`; the old one is retired, never edited')
  .option('--from-native', "import Claude Code auto-memory entries instead (memory-lead D13): project and reference entries only, each shown for the operator's yes or no on a terminal, marked as Claude memory's words")
  .option('--dir <path>', 'with --from-native: the auto-memory directory (default: as Claude Code resolves it for this repo)')
  .option('--initiative <slug>', 'initiative to record it under (default: the branch-bound one)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (text: string | undefined, opts: { supersedes?: string; fromNative?: boolean; dir?: string; initiative?: string; root?: string }) => {
    if (opts.fromNative === true) {
      if (text !== undefined || opts.supersedes !== undefined) {
        emit(fail('sofar remember --from-native: takes no text and no --supersedes — each entry comes from Claude memory, and a changed one supersedes its earlier import itself'))
        return
      }
      // The operator's act, never the agent's (D13): asked only on a real
      // terminal, never under CI, never from a piped agent shell.
      const terminal = process.stdin.isTTY === true && process.stderr.isTTY === true && process.env.CI === undefined
      const { createInterface } = await import('node:readline/promises')
      const rl = terminal ? createInterface({ input: process.stdin, output: process.stderr }) : null
      try {
        emit(
          await runNativeImport(
            rootOf(opts),
            { ...(opts.dir !== undefined ? { dir: opts.dir } : {}), ...(opts.initiative !== undefined ? { initiative: opts.initiative } : {}) },
            { ask: rl !== null ? (question: string) => rl.question(question) : null },
          ),
        )
      } finally {
        rl?.close()
      }
      return
    }
    if (opts.dir !== undefined) {
      emit(fail('sofar remember: --dir applies only with --from-native'))
      return
    }
    const input = await readInput(text, 'the text')
    if (!input.ok) {
      emit(fail(`sofar remember: ${input.error}`))
      return
    }
    emit(
      runRemember(rootOf(opts), input.text, {
        ...(opts.initiative !== undefined ? { initiative: opts.initiative } : {}),
        ...(opts.supersedes !== undefined ? { supersedes: opts.supersedes } : {}),
      }),
    )
  })

program
  .command('bind <decision> <cmd>')
  .description("give a standing rule the test that proves it: re-file D<n> as recorded, plus check {cmd}, superseding it (r3-fixes 2.10c)")
  .option('--hint <text>', 'the fix a failure shows')
  .option('--initiative <slug>', 'record to bind in (default: the bound one)')
  .option('--root <dir>', 'repo root (default: the record above the current directory)')
  .action((decision: string, cmd: string, opts: { hint?: string; initiative?: string; root?: string }) => {
    emit(
      runBind(rootOf(opts), decision, cmd, {
        ...(opts.initiative !== undefined ? { initiative: opts.initiative } : {}),
        ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
      }),
    )
  })

program
  .command('supersedes <decision> <target>')
  .description('say what a filed decision replaces, after the fact: D<m>, or none (r3-fixes 2.5) — answers a pending link')
  .option('--initiative <slug>', 'record the decisions are in (default: the bound one)')
  .option('--root <dir>', 'repo root (default: the record above the current directory)')
  .action((decision: string, target: string, opts: { initiative?: string; root?: string }) => {
    emit(runSupersedes(rootOf(opts), decision, target, opts.initiative !== undefined ? { initiative: opts.initiative } : {}))
  })

program
  .command('read <paths...>')
  .description('read record files as the index the agent needs: what a raw cat of plan.md, decisions.md, memory.md or events.jsonl becomes (memory-lead 4.3)')
  .option('--session <id>', 'the session reading: a re-read of an unchanged view prints one line')
  .option('--full', 'print the files as written')
  .action((paths: string[], opts: { session?: string; full?: boolean }) => {
    emit(runRead(process.cwd(), paths, { ...(opts.session !== undefined ? { session: opts.session } : {}), ...(opts.full === true ? { full: true } : {}) }))
  })

program
  .command('show <ids...>')
  .description('print record entries whole by handle: D12, M3, brief, brief¶4 (memory-lead 4.3)')
  .option('--initiative <slug>', 'record the entries are in (default: the bound one)')
  .option('--root <dir>', 'repo root (default: the record above the current directory)')
  .action((ids: string[], opts: { initiative?: string; root?: string }) => {
    emit(runShow(rootOf(opts), ids, opts.initiative !== undefined ? { initiative: opts.initiative } : {}))
  })

program
  .command('export [slug]')
  .description('write the initiative event log to stdout as NDJSON (sync cursor primitive)')
  .option('--since <id>', 'only events with ulid strictly after this id')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string | undefined, opts: { since?: string; root?: string }) => {
    emit(
      runExport(rootOf(opts), {
        ...(slug !== undefined ? { slug } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }),
    )
  })

program
  .command('diagnostics')
  .description(
    'show the private diagnostics store for this clone (path, rows per initiative and kind) — lives outside the repo, never exported or synced; --purge deletes it',
  )
  .option('--purge', 'delete every diagnostics row recorded for this clone')
  .option('--signals', 'print the signal availability map: what the loop may measure here, and what it must report as UNKNOWN')
  .option('--json', 'machine-readable output')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { purge?: boolean; signals?: boolean; json?: boolean; root?: string }) => {
    emit(
      runDiagnostics(rootOf(opts), {
        ...(opts.purge !== undefined ? { purge: opts.purge } : {}),
        ...(opts.signals !== undefined ? { signals: opts.signals } : {}),
        ...(opts.json !== undefined ? { json: opts.json } : {}),
      }),
    )
  })

program
  .command('tune [slug]')
  .description(
    'detect well-supported failure patterns in the record and the private diagnostics store, citing event ids and row hashes; prints UNKNOWN for every signal this clone cannot observe. Detection only — nothing is proposed or applied',
  )
  .option('--dry-run', 'REQUIRED: the only mode that exists — read, detect, report')
  .option('--all', 'every initiative under .sofar/initiatives/ (default: the resolved one)')
  .option('--json', 'machine-readable report (version-stamped, deterministic for the same inputs)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string | undefined, opts: { dryRun?: boolean; all?: boolean; json?: boolean; root?: string }) => {
    emit(
      runTune(rootOf(opts), {
        ...(slug !== undefined ? { slug } : {}),
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        ...(opts.all !== undefined ? { all: opts.all } : {}),
        ...(opts.json !== undefined ? { json: opts.json } : {}),
      }),
    )
  })

const suggest = program
  .command('suggest [slug]')
  .description(
    'loss rows from the detectors the 2.2 precision protocol trusts, each carrying that measurement and citing its evidence — never a cause, never a fix. --dry-run and --list read; record/approve/reject/revert are the verbs that write',
  )
  .option('--dry-run', 'derive what the record supports now and print it — writes nothing')
  .option('--list', 'every recorded candidate with its history, including ones whose evidence has moved')
  .option('--all', 'every initiative under .sofar/initiatives/ (default: the resolved one)')
  .option('--json', 'machine-readable')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string | undefined, opts: { dryRun?: boolean; list?: boolean; all?: boolean; json?: boolean; root?: string }) => {
    emit(
      runSuggest(rootOf(opts), {
        ...(slug !== undefined ? { slug } : {}),
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        ...(opts.list !== undefined ? { list: opts.list } : {}),
        ...(opts.all !== undefined ? { all: opts.all } : {}),
        ...(opts.json !== undefined ? { json: opts.json } : {}),
      }),
    )
  })

// The verbs are SUBCOMMANDS of `suggest`, so the surface reads the way the
// 2.3 contract names it: reading is the bare command, and every path that
// writes is spelled with a verb.
for (const verb of ['record', 'approve', 'reject', 'revert'] as const) {
  suggest
    .command(`${verb} <candidate>`)
    .description(
      verb === 'record'
        ? 'record a derived loss row in its initiative (writes one event; refuses a candidate the record no longer supports)'
        : verb === 'approve'
          ? 'approve a recorded loss row — binds to the exact candidate hash and is refused once its evidence moves'
          : verb === 'reject'
            ? 'reject a recorded loss row; the same evidence is then suppressed until it changes (--reason required)'
            : 'end an approval with a new event — history is never erased (--reason required)',
    )
    .option('--reason <text>', verb === 'record' || verb === 'approve' ? 'why' : 'REQUIRED: why')
    .option('--root <dir>', 'repo root (default: current directory)')
    .action((candidate: string, opts: { reason?: string; root?: string }, cmd: Command) => {
      // `--root` may land on either half of `sofar suggest record <c> --root x`
      // — commander gives the parent's copy to the parent. Reading the wrong
      // one silently resolves the CWD instead of the named repo.
      const parentRoot = (cmd.parent?.opts() as { root?: string } | undefined)?.root
      emit(
        runSuggestVerb(rootOf({ ...(opts.root ?? parentRoot ? { root: opts.root ?? parentRoot } : {}) }), verb, candidate, {
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        }),
      )
    })
}

program
  .command('import <file> [slug]')
  .description('import an NDJSON event stream (file, or "-" for stdin) — dedupes by id, idempotent')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (file: string, slug: string | undefined, opts: { root?: string }) => {
    let stream: string
    try {
      stream = file === '-' ? await readAllStdin() : readFileSync(file, 'utf8')
    } catch (err) {
      emit({
        exitCode: 1,
        stdout: '',
        stderr: `sofar import: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    emit(runImport(rootOf(opts), stream, slug !== undefined ? { slug } : {}))
  })

program
  .command('login')
  .description('sign in to api.sofar.sh (RFC-8628 device flow) and store a machine token — the credential never touches the repo')
  .option('--api <url>', 'API base URL (default: SOFAR_API_URL, .sofar/remote.json, then https://api.sofar.sh)')
  .option('--scopes <scopes>', 'comma-separated token scopes: sync (read-write) or read (read-only)', 'sync')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { api?: string; scopes?: string; root?: string }) => {
    emit(
      await runLogin(rootOf(opts), {
        ...(opts.api !== undefined ? { api: opts.api } : {}),
        ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
      }),
    )
  })

program
  .command('link')
  .description('bind this repo to a sofar-cloud org/repo: writes the committable .sofar/remote.json (idempotent on org+name)')
  .requiredOption('--org <slug>', 'organization slug on the server')
  .option('--name <repo>', 'repo name on the server (default: this directory\'s basename)')
  .option('--api <url>', 'API base URL (default: SOFAR_API_URL, .sofar/remote.json, then https://api.sofar.sh)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { org: string; name?: string; api?: string; root?: string }) => {
    emit(
      await runLink(rootOf(opts), {
        org: opts.org,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.api !== undefined ? { api: opts.api } : {}),
      }),
    )
  })

/** Shared option shape for push/pull. */
function syncOptions(slug: string | undefined, opts: { all?: boolean; full?: boolean; api?: string }) {
  return {
    ...(slug !== undefined ? { slug } : {}),
    all: opts.all === true,
    full: opts.full === true,
    ...(opts.api !== undefined ? { api: opts.api } : {}),
  }
}

program
  .command('push [slug]')
  .description('push initiative events to the linked sofar-cloud repo (ulid order, from genesis on first push; idempotent by event id)')
  .option('--all', 'push every initiative under .sofar/initiatives/')
  .option('--full', 'ignore the ack cursor and re-push the stream from event zero')
  .option('--api <url>', 'API base URL override')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (slug: string | undefined, opts: { all?: boolean; full?: boolean; api?: string; root?: string }) => {
    emit(await runPush(rootOf(opts), syncOptions(slug, opts)))
  })

program
  .command('pull [slug]')
  .description('pull initiative events from the linked sofar-cloud repo (since-cursor paging, dedupe by id); --watch keeps pulling on the doorbell')
  .option('--all', 'pull every initiative under .sofar/initiatives/')
  .option('--full', 'ignore the inbound cursor and re-pull the stream from genesis')
  .option('--watch', 'stay connected: subscribe to the doorbell (SSE) and pull on every ring (^C to stop)')
  .option('--api <url>', 'API base URL override')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (slug: string | undefined, opts: { all?: boolean; full?: boolean; watch?: boolean; api?: string; root?: string }) => {
    if (opts.watch === true) {
      const result = await runPullWatch(rootOf(opts), syncOptions(slug, opts))
      if (result !== undefined) emit(result) // fatal setup/auth failure
      return
    }
    emit(await runPull(rootOf(opts), syncOptions(slug, opts)))
  })

program
  .command('drive [slug]')
  .description(
    'run an initiative task-by-task through fresh headless agent sessions: next task from the fold → launch → wait → record the handoff, until a stop rule fires (^C stops the run, not just the session)',
  )
  .option(
    '--policy <policy>',
    'session policy: `task` (one task per session; the default) or `threshold` (pack tasks until the context gauge fires)',
  )
  .option('--threshold-pct <pct>', 'nudge the session to hand off at this % of the window; REQUIRED for --policy threshold')
  .option(
    '--context-window <tokens>',
    "the window that percentage is OF; REQUIRED for --policy threshold — state your model's, sofar never guesses it",
  )
  .option('--max-sessions <n>', 'stop before launching more than n sessions; bounds ONE driver, not the run — a resumed run counts only its recorded handoffs')
  .option('--max-stalls <n>', 'stop after n consecutive sessions with no task change (default 2)')
  .option('--cost-cap <usd>', 'stop before the next launch once the adapter has reported this much cost')
  .option(
    '--session-timeout <seconds>',
    'kill a session that has not ended in this long (default: wait forever) — an unattended run should state it',
  )
  .option('--cwd <dir>', 'directory to launch sessions in (default: repo root); must serve the SAME record')
  .option('--model <model>', "model for every launch — outranks any task's own route hint")
  .option('--effort <effort>', "effort for every launch — outranks any task's own route hint")
  .option('--resume', 'adopt the latest run when it has no stop, instead of refusing to start')
  .option(
    '--verify <cmd>',
    'acceptance command run before a task the agent marked done is accepted (r1-fixes 3.1); a task\'s own plan `verify` wins',
  )
  .option('--verify-timeout <seconds>', 'kill an acceptance command that has not ended in this long (default 600)')
  .option('--max-verify-attempts <n>', 'stop the run once one task has failed verification this many times (default 3)')
  .option(
    '--agent <name>',
    'default headless agent: claude-code (default), codex or cursor (cursor-agent) — a task whose plan entry carries route.agent is launched with THAT one instead',
  )
  .option('--bin <path>', "agent binary to spawn (default: the agent's own — claude, codex, cursor-agent)")
  .option(
    '--agent-arg <arg>',
    "extra argv for the agent named by --agent, repeat once per argument (e.g. --agent-arg=--debug) — the escape hatch past sofar's own flags",
    (arg: string, acc: string[] | undefined) => [...(acc ?? []), arg],
  )
  .option(
    '--permission-mode <mode>',
    'permission mode every session runs under (default: acceptEdits — an unattended session cannot answer a prompt)',
  )
  .option(
    '--allow <rule...>',
    "permission rules ADDED to sofar's floor, e.g. 'Bash(npm test:*)' — state what proving a task done needs here",
  )
  .option('--deny <rule...>', 'permission rules denied to every session in the run')
  .option('--bare-tools', "drop sofar's default allow-list; --allow then states the whole surface")
  .option(
    '--detach',
    "start the run as a process that outlives this shell — how an agent session starts one; returns once the run is certain to start",
  )
  .option(
    '--stop',
    "ask the latest unstopped run's driver to end it (a second --stop kills its session outright) — how a detached run is stopped",
  )
  .option(
    '--await',
    "block until the latest unstopped run needs someone, then print one line: its stop (exit 0), its driver gone (exit 2), or nothing to await (exit 1) — for an agent's background shell",
  )
  .option(
    '--follow',
    'print one line per handoff, task change, adoption and stop request of the latest unstopped run as it lands, ending like --await — for a terminal, not an agent (every line there is a turn)',
  )
  .option('--keep-awake', 'macOS: block idle sleep for this run (caffeinate), whatever the saved setting says; not saved')
  .option('--no-keep-awake', 'macOS: do not block idle sleep for this run, whatever the saved setting says; not saved')
  .option(
    '--keep-awake-setting <on|off>',
    'save whether runs keep this Mac awake (~/.config/sofar/config.json) and start nothing; a running driver picks it up before its next launch',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(
    async (
      slug: string | undefined,
      opts: {
        policy?: string
        thresholdPct?: string
        contextWindow?: string
        maxSessions?: string
        maxStalls?: string
        costCap?: string
        sessionTimeout?: string
        cwd?: string
        model?: string
        effort?: string
        resume?: boolean
        verify?: string
        verifyTimeout?: string
        maxVerifyAttempts?: string
        agent?: string
        bin?: string
        agentArg?: string[]
        permissionMode?: string
        allow?: string[]
        deny?: string[]
        bareTools?: boolean
        detach?: boolean
        stop?: boolean
        await?: boolean
        follow?: boolean
        keepAwake?: boolean
        keepAwakeSetting?: string
        root?: string
      },
    ) => {
      if (opts.keepAwakeSetting !== undefined) {
        // A machine preference, not a run: a slug or run flag beside it would
        // read as honoured and be ignored.
        const extra = Object.keys(opts).filter((k) => k !== 'keepAwakeSetting' && k !== 'root')
        if (slug !== undefined || extra.length > 0) {
          emit(fail('sofar drive --keep-awake-setting takes no initiative and no other flag — it saves a setting for this machine and starts nothing'))
          return
        }
        emit(runKeepAwakeSetting(opts.keepAwakeSetting))
        return
      }
      // --stop, --await and --follow name a run, not a way to run one: a flag
      // beside any of them would read as honoured and be ignored.
      const only = opts.stop === true ? 'stop' : opts.await === true ? 'await' : opts.follow === true ? 'follow' : undefined
      if (only !== undefined) {
        const extra = Object.keys(opts).filter((k) => k !== only && k !== 'root')
        if (extra.length > 0) {
          emit(fail(`sofar drive --${only} takes no other flag but --root (got ${extra.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')})`))
          return
        }
        emit(
          only === 'stop'
            ? await runDriveStop(rootOf(opts), slug)
            : only === 'await'
              ? await runDriveAwait(rootOf(opts), slug)
              : await runDriveFollow(rootOf(opts), slug),
        )
        return
      }
      if (opts.detach === true) {
        emit(
          await runDriveDetached(rootOf(opts), slug, {
            argv: process.argv.slice(2),
            ...(opts.keepAwake !== undefined ? { keepAwake: opts.keepAwake } : {}),
            prompt: terminalPrompt(),
          }),
        )
        return
      }
      const onStarted = detachedStartNotifier()
      emit(
        await runDrive(rootOf(opts), slug, {
          ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
          ...(opts.thresholdPct !== undefined ? { thresholdPct: opts.thresholdPct } : {}),
          ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
          ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
          ...(opts.maxStalls !== undefined ? { maxStalls: opts.maxStalls } : {}),
          ...(opts.costCap !== undefined ? { costCap: opts.costCap } : {}),
          ...(opts.sessionTimeout !== undefined ? { sessionTimeout: opts.sessionTimeout } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          ...(opts.resume === true ? { resume: true } : {}),
          ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
          ...(opts.verifyTimeout !== undefined ? { verifyTimeout: opts.verifyTimeout } : {}),
          ...(opts.maxVerifyAttempts !== undefined ? { maxVerifyAttempts: opts.maxVerifyAttempts } : {}),
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts.bin !== undefined ? { bin: opts.bin } : {}),
          ...(opts.agentArg !== undefined ? { agentArgs: opts.agentArg } : {}),
          ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
          ...(opts.allow !== undefined ? { allow: opts.allow } : {}),
          ...(opts.deny !== undefined ? { deny: opts.deny } : {}),
          ...(opts.bareTools === true ? { bareTools: true } : {}),
          ...(onStarted !== undefined ? { onStarted } : {}),
          ...(opts.keepAwake !== undefined ? { keepAwake: opts.keepAwake } : {}),
          prompt: terminalPrompt(),
        }),
      )
    },
  )

program
  .command('serve')
  .description('watch .sofar/ and serve initiative state as JSON on 127.0.0.1 (GET /state, /state/<slug>, /events SSE)')
  .option('--port <port>', 'port to bind on 127.0.0.1', String(DEFAULT_PORT))
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { port: string; root?: string }) => {
    const port = Number.parseInt(opts.port, 10)
    if (Number.isNaN(port) || port < 0 || port > 65_535) {
      emit({ exitCode: 1, stdout: '', stderr: `sofar serve: invalid port "${opts.port}"` })
      return
    }
    const handle = await startServer({ root: rootOf(opts), port })
    process.stderr.write(renderServeBanner(handle.url))
    // long-running: the server keeps the event loop alive until Ctrl-C
  })

program
  .command('mcp')
  .description('start the stdio MCP server (server name: sofar) exposing the SPEC §MCP tools')
  .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
  .action(async (opts: { root?: string }) => {
    // A stdio child of one Claude Code session adopts that session (memory-lead D3).
    const handle = createSofarServer({ rootDir: opts.root, hostSessionId: process.env.CLAUDE_CODE_SESSION_ID })
    await handle.connectStdio()
    // stdio transport keeps the process alive until the client disconnects
  })

program
  .command('upgrade [version]')
  .description(
    'self-update the globally-installed sofar to the latest release (or a given version), resolving the true install prefix from sofar\'s own location so a custom npm prefix is handled correctly',
  )
  .option('--check', 'report installed-vs-latest and the resolved install; change nothing')
  .option('--dry-run', 'print the exact npm command that would run; change nothing')
  .option('--force', 'reinstall even when already at the target version')
  .option(
    '--auto <on|off>',
    'turn background auto-install on or off and exit — when on, the daily check installs the update itself instead of only telling you about it',
  )
  .action(
    async (
      version: string | undefined,
      opts: { check?: boolean; dryRun?: boolean; force?: boolean; auto?: string },
    ) => {
      if (opts.auto !== undefined) {
        const value = opts.auto.trim().toLowerCase()
        if (value !== 'on' && value !== 'off') {
          emit(fail(`sofar upgrade: --auto takes "on" or "off" (got "${opts.auto}")`))
          return
        }
        writeAutoUpgrade(value === 'on')
        emit(
          ok(
            value === 'on'
              ? 'auto-upgrade on — the daily check will install updates in the background.\n' +
                  'Each install still asks you to run `sofar init --refresh` per repo to refresh its wiring.\n'
              : 'auto-upgrade off — sofar will tell you about updates and let you install them.\n',
          ),
        )
        return
      }
      emit(
        await runUpgrade({
          ...(version !== undefined ? { version } : {}),
          check: opts.check === true,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
        }),
      )
    },
  )

program
  .command('update-check')
  .description(
    'inspect the cached update check (installed vs latest, when it last ran, whether auto-install is on); --refresh performs the check that the background child normally does',
  )
  .option('--refresh', 'query the registry now and rewrite the cache — the detached child\'s own entry point')
  .action((opts: { refresh?: boolean }) => {
    emit(opts.refresh === true ? runRefresh() : runCheckStatus())
  })

registerEventCommand(program)
registerFoldCommand(program)
registerCommitTrailerCommand(program, rootOf)
registerReviewCommand(program, rootOf)
registerStatuslineCommand(program, rootOf)

await program.parseAsync(process.argv)
