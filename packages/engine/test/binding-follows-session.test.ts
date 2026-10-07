import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { writeBinding } from '../src/core/bindings'
import { readLastHomes } from '../src/core/last-home'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handleSessionStart } from '../src/cli/event'
import { runStatusline } from '../src/cli/statusline'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { startSession } from '../src/mcp/start-session'

/**
 * binding-follows-session 1.3 — the branch binding maintains itself.
 *
 * The case that opened it: brillo's main stayed bound to
 * baseui-toast-migration across 8 project-tax-architecture commits, because
 * only a human `sofar switch` ever moved a binding. Every fresh session there
 * opened on the wrong record and had to be re-homed by hand.
 *
 * The fix writes, it does not infer (D1): a write-back binds the branch to the
 * initiative it landed in, so `bindings.json` states "last session to finish
 * here" as a durable fact. Resolution itself is untouched — session-orientation
 * D2 still stands, and nothing below asserts a new resolution RULE, only that
 * the fact the existing rule reads has stopped decaying.
 *
 * The guards get a test each because every one of them is a case where doing
 * the obvious thing is wrong: an unbound branch was unbound on purpose, a
 * closed record must not collect new sessions, and a routing convenience must
 * never be able to fail a wrap-up.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const T = {
  created: '2026-08-13T08:00:00.000Z',
  peerStart: '2026-08-13T09:00:00.000Z',
  mineStart: '2026-08-13T10:00:00.000Z',
  closed: '2026-08-13T11:00:00.000Z',
}

function emit(
  sofar: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): void {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), { ...e, ts })
}

/**
 * The other branches of the fixture repo, bound so that BOTH records are in
 * the routing table. The fourth guard (no-bind-durability 1.1) only ever moves
 * a branch between slugs the operator has already routed to, so a fixture
 * where beta appeared nowhere would silently exercise that guard instead of
 * the three these cases were written for.
 */
const OTHERS = { 'wip/alpha': 'alpha', 'wip/beta': 'beta' }

/**
 * main → alpha, a peer registered in alpha, and MINE registered in beta — the
 * shape after a re-home, which is exactly when the binding is stale.
 * `bindings` is written verbatim so a test can hand in an absent or malformed
 * file without a second helper.
 */
function repo(
  bindings: string | null = `${JSON.stringify({ main: 'alpha', ...OTHERS }, null, 2)}\n`,
): {
  root: string
  sofar: string
} {
  const root = mkdtempSync(join(tmpdir(), 'sofar-rebind-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  if (bindings !== null) writeFileSync(join(sofar, 'bindings.json'), bindings)

  emit(sofar, 'alpha', 'cli', 'initiative_created', { slug: 'alpha', goal: 'the bound one' }, T.created)
  emit(sofar, 'beta', 'cli', 'initiative_created', { slug: 'beta', goal: 'the worked one' }, T.created)
  emit(sofar, 'alpha', 'PEER', 'session_started', { tool: 'claude-code' }, T.peerStart)
  emit(sofar, 'beta', 'MINE', 'session_started', { tool: 'claude-code' }, T.mineStart)
  return { root, sofar }
}

const readBindings = (sofar: string): unknown =>
  JSON.parse(readFileSync(join(sofar, 'bindings.json'), 'utf8'))

/**
 * Where the write-back's move lands since r4-fixes A10 (R11 (b)): the worked
 * worktree's untracked last home, never the committed bindings.json.
 */
const lastHome = (sofar: string, branch: string): string | undefined => readLastHomes(sofar)[branch]?.slug

const wrapUp = (root: string, session: string) =>
  endSession(createToolContext(root), {
    session_id: session,
    summary: 'did the work',
    next_action: 'next thing',
  })

const record = (root: string, session: string): string =>
  runStatusline(root, JSON.stringify({ session_id: session, workspace: { current_dir: root } }))
    .split(' · ')
    .pop()!

describe('the branch binding follows the write-back (binding-follows-session 1.3)', () => {
  it('moves the branch to where the session actually lived', () => {
    const { root, sofar } = repo()
    const result = wrapUp(root, 'MINE')

    // The committed file is untouched; the move is this worktree's (A10).
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
    expect(lastHome(sofar, 'main')).toBe('beta')
    // Reported, because an inspectable mechanism must be legible at the moment
    // it acts — that is the whole reason a binding beat an inference (D1).
    expect(result.rebound).toEqual({ branch: 'main', from: 'alpha', to: 'beta' })

    // The point of the whole change: the NEXT fresh session lands on the
    // finished work, through unchanged branch resolution.
    expect(record(root, 'SOMEONE-ELSE')).toContain('beta')
    const block = handleSessionStart(
      root,
      JSON.stringify({ session_id: 'SOMEONE-ELSE', cwd: root, source: 'startup' }),
    ).stdout
    expect(block).toContain('# Sofar status: beta')
    // And the recent-work notice goes QUIET, because the branch no longer
    // disagrees with where the work happened. That is the second gain: the
    // line stops firing on chronic staleness and is left to speak only when
    // the branch is genuinely wrong — the "learned to skip it" failure
    // record-integrity D3 named.
    expect(block).not.toContain('More recent work is in ANOTHER record')
  })

  it('stays quiet when the session lived where the branch already pointed', () => {
    const { root, sofar } = repo()
    const result = wrapUp(root, 'PEER') // PEER's home IS alpha

    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
    // Omitted rather than reported as a no-op: presence is the signal, the
    // same shape parallel_writebacks uses.
    expect(result.rebound).toBeUndefined()
  })

  it('MOVES a binding but never CREATES one', () => {
    // `sofar new --no-bind` is a deliberate "do not route this branch", and a
    // fresh session on an unbound branch already gets a block telling it to
    // switch. Inventing a binding here would overrule a choice.
    const { root, sofar } = repo(null)
    const result = wrapUp(root, 'MINE')

    expect(() => readBindings(sofar)).toThrow() // still no file at all
    expect(result.rebound).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('never points a branch at a CLOSED record', () => {
    const { root, sofar } = repo()
    emit(sofar, 'beta', 'cli', 'initiative_status_changed', { status: 'done' }, T.closed)

    const result = wrapUp(root, 'MINE')

    // The write-back still lands in beta — a closed record is where this
    // session lived, and its wrap-up belongs there. Only the ROUTING of future
    // sessions is withheld.
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
    expect(result.rebound).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('survives a malformed bindings.json without failing the wrap-back', () => {
    const { root, sofar } = repo('{ this is not json')
    const result = wrapUp(root, 'MINE')

    // Best-effort (BD22): the write-back is the caller's obligation and the
    // Stop gate's release — a routing convenience must never be able to break
    // it, and readBindingsFile's refusal to overwrite a bad file is preserved.
    expect(result.ok).toBe(true)
    expect(result.rebound).toBeUndefined()
    expect(readFileSync(join(sofar, 'bindings.json'), 'utf8')).toBe('{ this is not json')
  })

  it('cannot pull a live peer off its own record', () => {
    const { root, sofar } = repo()
    wrapUp(root, 'MINE')
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
    expect(lastHome(sofar, 'main')).toBe('beta')

    // The peer resolves through its own home, which the moved binding only
    // ever SEEDS (mcp/context.ts:194) — so a rebind under a running session is
    // invisible to it, on every surface.
    expect(record(root, 'PEER')).toContain('alpha')
    expect(handleSessionStart(
      root,
      JSON.stringify({ session_id: 'PEER', cwd: root, source: 'startup' }),
    ).stdout).toContain('# Sofar status: alpha')

    // Including its own write-back, which still lands in alpha and moves the
    // branch back — last to finish wins, the accepted limitation in D1.
    const peer = wrapUp(root, 'PEER')
    expect(peer.rebound).toEqual({ branch: 'main', from: 'beta', to: 'alpha' })
  })

  it('follows a re-home through one call, without re-homing being what binds', () => {
    const { root, sofar } = repo()
    // A session mis-homed onto the branch's record by lazy registration.
    emit(sofar, 'alpha', 'STRAY', 'session_started', { tool: 'claude-code' }, T.mineStart)
    const ctx = createToolContext(root)

    startSession(ctx, { tool: 'claude-code', session_id: 'STRAY', initiative: 'beta' })
    // Re-homing alone still touches nothing — the property rehome.test.ts pins.
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })

    // It is the WRITE-BACK that makes the move durable, which is why the bind
    // lives here and not in start_session: a re-home is not always a statement
    // of intent (D1 was taken by a session that re-homed into a closed record
    // purely to read it).
    expect(endSession(ctx, { session_id: 'STRAY', summary: 's', next_action: 'n' }).rebound).toEqual({
      branch: 'main',
      from: 'alpha',
      to: 'beta',
    })
  })
})

/**
 * no-bind-durability 1.1 — the fourth guard.
 *
 * `sofar new beta --no-bind` states that THIS branch must not be routed to the
 * new record. Move-only honoured that on an unbound branch and nowhere else: a
 * branch already bound to alpha was moved onto beta by the first write-back,
 * so the flag survived exactly until the session that set it wrapped up.
 *
 * The guard is derived from bindings.json alone (D1): the rebind moves a
 * branch between initiatives the operator has already routed to, and putting a
 * NEW slug in the routing table stays the operator's act — `sofar new` without
 * the flag, or `sofar switch`. Nothing here reads the flag itself, which is
 * why no event and no schema field were needed to hold it.
 */
describe('a write-back never introduces an initiative to the routing table (no-bind-durability 1.1)', () => {
  /** `sofar new beta --no-bind` from main: beta exists, no branch points at it. */
  const noBind = `${JSON.stringify({ main: 'alpha' }, null, 2)}\n`

  it('leaves --no-bind standing on a branch that is bound elsewhere', () => {
    const { root, sofar } = repo(noBind)
    const result = wrapUp(root, 'MINE')

    expect(readBindings(sofar)).toEqual({ main: 'alpha' })
    expect(result.rebound).toBeUndefined()
    // The write-back itself still lands in beta and still succeeds — only the
    // ROUTING of future sessions is withheld, the same shape the closed-record
    // guard takes.
    expect(result.ok).toBe(true)
    expect(record(root, 'SOMEONE-ELSE')).toContain('alpha')
  })

  it('resumes the move once an explicit bind puts beta in the table', () => {
    const { root, sofar } = repo(noBind)
    // The retraction. `sofar switch` on any branch goes through this same
    // writer, and saying beta is a record this repo routes to is all it takes:
    // the guard reads membership, not which branch supplied it.
    writeBinding(join(sofar, 'bindings.json'), 'wip/beta', 'beta')

    const result = wrapUp(root, 'MINE')

    expect(readBindings(sofar)).toEqual({ main: 'alpha', 'wip/beta': 'beta' })
    expect(lastHome(sofar, 'main')).toBe('beta')
    expect(result.rebound).toEqual({ branch: 'main', from: 'alpha', to: 'beta' })
  })
})

describe('the rebind follows the worktree the session worked in (binding-follows-session D4)', () => {
  /**
   * The shape of 2026-09-24/25: the MCP server runs in the main checkout, but
   * the session edits a linked worktree W on branch `feat`. W carries its own
   * .sofar/bindings.json, the file a fresh session there resolves through.
   */
  function withWorktree(): { root: string; sofar: string; wt: string } {
    const { root, sofar } = repo()
    const wt = mkdtempSync(join(tmpdir(), 'sofar-rebind-wt-'))
    roots.push(wt)
    const gitdir = join(root, '.git', 'worktrees', 'feat')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/feat\n')
    writeFileSync(join(gitdir, 'commondir'), '../..\n')
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    mkdirSync(join(wt, '.sofar'), { recursive: true })
    writeFileSync(join(wt, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'alpha', feat: 'alpha', ...OTHERS }, null, 2)}\n`)
    return { root, sofar, wt }
  }
  const touch = (sofar: string, path: string, ts: string): void =>
    emit(sofar, 'beta', 'MINE', 'file_touched', { path, op: 'edit' }, ts)
  const wtBindings = (wt: string): unknown => JSON.parse(readFileSync(join(wt, '.sofar', 'bindings.json'), 'utf8'))

  it("rebinds the worktree's branch in the worktree's own bindings, and leaves main untouched", () => {
    const { root, sofar, wt } = withWorktree()
    touch(sofar, join(wt, 'src', 'a.ts'), '2026-08-13T10:05:00.000Z')
    const result = wrapUp(root, 'MINE')
    expect(result.rebound).toEqual({ branch: 'feat', from: 'alpha', to: 'beta' })
    expect(wtBindings(wt)).toMatchObject({ feat: 'alpha', main: 'alpha' })
    expect(lastHome(join(wt, '.sofar'), 'feat')).toBe('beta')
    expect(lastHome(sofar, 'main')).toBeUndefined()
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
  })

  it('the plain same-checkout case is unchanged: edits in the server checkout rebind its branch', () => {
    const { root, sofar } = withWorktree()
    touch(sofar, join(root, 'src', 'a.ts'), '2026-08-13T10:05:00.000Z')
    expect(wrapUp(root, 'MINE').rebound).toEqual({ branch: 'main', from: 'alpha', to: 'beta' })
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
    expect(lastHome(sofar, 'main')).toBe('beta')
  })

  it('SOFAR_LASTHOME=committed restores the committed rebind (the A10 switch)', () => {
    const { root, sofar } = withWorktree()
    touch(sofar, join(root, 'src', 'a.ts'), '2026-08-13T10:05:00.000Z')
    process.env.SOFAR_LASTHOME = 'committed'
    try {
      expect(wrapUp(root, 'MINE').rebound).toEqual({ branch: 'main', from: 'alpha', to: 'beta' })
    } finally {
      delete process.env.SOFAR_LASTHOME
    }
    expect(readBindings(sofar)).toEqual({ main: 'beta', ...OTHERS })
    expect(lastHome(sofar, 'main')).toBeUndefined()
  })

  it("files outside every worktree of this repo say nothing, so the server's branch is used as before", () => {
    const { root, sofar, wt } = withWorktree()
    const elsewhere = mkdtempSync(join(tmpdir(), 'sofar-rebind-scratch-'))
    roots.push(elsewhere)
    touch(sofar, join(elsewhere, 'notes.txt'), '2026-08-13T10:05:00.000Z')
    expect(wrapUp(root, 'MINE').rebound?.branch).toBe('main')
    expect(wtBindings(wt)).toMatchObject({ feat: 'alpha' })
  })

  it("a sibling repo's worktree is not this repo's, and the record's own .sofar paths are ignored", () => {
    const { root, sofar, wt } = withWorktree()
    const other = mkdtempSync(join(tmpdir(), 'sofar-rebind-other-'))
    roots.push(other)
    mkdirSync(join(other, '.git'), { recursive: true })
    writeFileSync(join(other, '.git', 'HEAD'), 'ref: refs/heads/feat\n')
    touch(sofar, join(wt, 'src', 'a.ts'), '2026-08-13T10:05:00.000Z')
    touch(sofar, join(other, 'x.ts'), '2026-08-13T10:06:00.000Z')
    touch(sofar, join(root, '.sofar', 'initiatives', 'beta', 'events.jsonl'), '2026-08-13T10:07:00.000Z')
    expect(wrapUp(root, 'MINE').rebound).toEqual({ branch: 'feat', from: 'alpha', to: 'beta' })
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
  })

  it('when the work spans checkouts, the one touched last wins', () => {
    const { root, sofar, wt } = withWorktree()
    touch(sofar, join(root, 'README.md'), '2026-08-13T10:05:00.000Z')
    touch(sofar, join(wt, 'src', 'a.ts'), '2026-08-13T10:06:00.000Z')
    expect(wrapUp(root, 'MINE').rebound?.branch).toBe('feat')
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
  })

  it('keeps every guard in the worktree: an unbound feat branch stays unbound', () => {
    const { root, sofar, wt } = withWorktree()
    writeFileSync(join(wt, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'alpha', ...OTHERS }, null, 2)}\n`)
    touch(sofar, join(wt, 'src', 'a.ts'), '2026-08-13T10:05:00.000Z')
    expect(wrapUp(root, 'MINE').rebound).toBeUndefined()
    expect(readBindings(sofar)).toEqual({ main: 'alpha', ...OTHERS })
  })
})
