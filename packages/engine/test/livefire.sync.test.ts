import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeApiUrl, readCredential, readRemote, type Env } from '../src/client/config'
import { runLink, runLogin, runPull, runPullWatch, runPush } from '../src/cli/cloud'
import { runStatus } from '../src/cli/status'
import { detectCaps } from '../src/cli/ui'
import { readEvents } from '../src/core/cursor'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { scaled } from './helpers/tracked'

/**
 * LIVE E2E (sync-client 5.2, SPEC §Acceptance criteria) — runs only when
 * SOFAR_LIVE_API points at a running api.sofar.sh, e.g. a local one:
 *
 *   cd ../sofar-cloud/apps/api
 *   SOFAR_AUTH_TEST=1 BETTER_AUTH_SECRET=$(openssl rand -base64 32) bun dev
 *   SOFAR_LIVE_API=http://localhost:8787 npm test -- livefire.sync
 *
 * Exercises the REAL wire: email/password sign-up (test-only server flag)
 * for a web session, the manual device claim+approve path from that
 * session, `sofar login` end to end, org create, link, push → fresh-clone
 * pull round-trip, idempotent re-push, and one live doorbell ring.
 */

const LIVE = process.env.SOFAR_LIVE_API
const apiUrl = LIVE !== undefined && LIVE.trim().length > 0 ? normalizeApiUrl(LIVE) : null

const scratch = mkdtempSync(join(tmpdir(), 'sofar-livefire-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const plain = detectCaps({ env: {}, argv: [], isTTY: false, platform: 'darwin' })
/** Real pacing, capped short — respects the poll loop without 5s waits. */
const fastSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 750)))

let n = 0
function freshClone(name: string): { root: string; env: Env } {
  const root = join(scratch, `${n++}-${name}`)
  mkdirSync(root, { recursive: true })
  return { root, env: { XDG_CONFIG_HOME: join(root, '.xdg-config'), XDG_STATE_HOME: join(root, '.xdg-state') } }
}

describe.runIf(apiUrl !== null)(`live sync E2E against ${apiUrl ?? '(unset)'}`, () => {
  const api = apiUrl!
  const stamp = Date.now().toString(36)
  const orgSlug = `e2e-${stamp}`
  let sessionToken = ''

  /**
   * The "web browser": claim the code with the session, then approve it.
   * Better Auth's browser-shaped requests must carry a matching Origin
   * (undici's sec-fetch-mode triggers the check) — a real web app would.
   */
  function claimAndApprove(url: string): void {
    void (async () => {
      const userCode = new URL(url).searchParams.get('user_code')!
      const claim = await fetch(`${api}/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
        headers: { authorization: `Bearer ${sessionToken}`, origin: api },
      })
      if (!claim.ok) throw new Error(`claim failed: ${claim.status} ${await claim.text()}`)
      const approve = await fetch(`${api}/api/auth/device/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json', origin: api },
        body: JSON.stringify({ userCode }),
      })
      if (!approve.ok) throw new Error(`approve failed: ${approve.status} ${await approve.text()}`)
    })()
  }

  it('signs up a throwaway user (SOFAR_AUTH_TEST server) and creates an org', async () => {
    const res = await fetch(`${api}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: api },
      body: JSON.stringify({ email: `e2e-${stamp}@sofar.test`, password: `pw-${stamp}-long-enough`, name: 'E2E' }),
    })
    expect(res.status, 'sign-up requires the server started with SOFAR_AUTH_TEST=1').toBe(200)
    sessionToken = res.headers.get('set-auth-token') ?? ((await res.json()) as { token?: string }).token ?? ''
    expect(sessionToken.length).toBeGreaterThan(0)

    const org = await fetch(`${api}/v1/orgs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: orgSlug, name: `E2E ${stamp}` }),
    })
    expect(org.status).toBe(201)
  }, scaled(30_000))

  const writer = freshClone('writer')

  it('logs in through the real device flow (manual claim+approve path)', async () => {
    const result = await runLogin(
      writer.root,
      { api },
      { env: writer.env, sleep: fastSleep, openBrowser: claimAndApprove, out: () => {}, tokenName: 'livefire' },
      plain,
      plain,
    )
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const credential = readCredential(api, writer.env)
    expect(credential?.token).toMatch(/^sfr_/)
    expect(result.stdout).not.toContain(credential!.token)
  }, scaled(60_000))

  it('links, pushes, and round-trips into a fresh clone with zero-diff status', async () => {
    const link = await runLink(writer.root, { org: orgSlug, name: `repo-${stamp}`, api }, { env: writer.env }, plain, plain)
    expect(link.stderr).toBe('')
    expect(link.exitCode).toBe(0)
    const remote = readRemote(writer.root)!
    expect(remote.repo_id.length).toBeGreaterThan(0)

    const log = join(writer.root, '.sofar', 'initiatives', 'live', 'events.jsonl')
    appendEvents(log, [
      makeEvent({ initiative: 'live', session: 'cli', source: 'cli', actor: 'agent', type: 'initiative_created', payload: { slug: 'live', goal: 'live round-trip' } }),
      makeEvent({ initiative: 'live', session: 'cli', source: 'cli', actor: 'agent', type: 'note_added', payload: { text: 'over the real wire' } }),
    ])
    const push = await runPush(writer.root, { slug: 'live' }, { env: writer.env }, plain, plain)
    expect(push.stderr).toBe('')
    expect(push.stdout).toContain('pushed live: 2 new')

    // idempotency on the real server
    const again = await runPush(writer.root, { slug: 'live', full: true }, { env: writer.env }, plain, plain)
    expect(again.stdout).toContain('pushed live: 0 new, 2 already on server')

    // fresh clone: same credential file, its own cursors
    const clone = freshClone('clone')
    const { cpSync } = await import('node:fs')
    cpSync(join(writer.env.XDG_CONFIG_HOME!), join(clone.env.XDG_CONFIG_HOME!), { recursive: true })
    mkdirSync(join(clone.root, '.sofar'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(clone.root, '.sofar', 'remote.json'), `${JSON.stringify(remote, null, 2)}\n`)

    const pull = await runPull(clone.root, { slug: 'live' }, { env: clone.env }, plain, plain)
    expect(pull.stderr).toBe('')
    expect(pull.stdout).toContain('pulled live: 2 new, 0 already local')
    expect(readEvents(join(clone.root, '.sofar', 'initiatives', 'live', 'events.jsonl')).events).toEqual(
      readEvents(log).events,
    )
    expect(runStatus(clone.root, 'live').stdout).toBe(runStatus(writer.root, 'live').stdout)
  }, scaled(60_000))

  it('a push reaches a live watcher — by doorbell ring, or by gap catch-up if the SSE channel is unusable', async () => {
    // Known server gap (surfaced Jul 2026): Bun.serve's default 10s
    // idleTimeout kills the doorbell before the 25s heartbeat, and headers
    // only flush on first write — so today this exercises the client's
    // degraded path (pull on every gap). Once the server pins idleTimeout
    // + flushes an initial comment, the same test rides the actual ring.
    const remote = readRemote(writer.root)!
    const watcher = freshClone('watcher')
    const { cpSync, writeFileSync } = await import('node:fs')
    cpSync(join(writer.env.XDG_CONFIG_HOME!), join(watcher.env.XDG_CONFIG_HOME!), { recursive: true })
    mkdirSync(join(watcher.root, '.sofar'), { recursive: true })
    writeFileSync(join(watcher.root, '.sofar', 'remote.json'), `${JSON.stringify(remote, null, 2)}\n`)

    appendEvents(join(writer.root, '.sofar', 'initiatives', 'live', 'events.jsonl'), [
      makeEvent({ initiative: 'live', session: 'cli', source: 'cli', actor: 'agent', type: 'note_added', payload: { text: 'ring me' } }),
    ])
    const push = await runPush(writer.root, { slug: 'live' }, { env: writer.env }, plain, plain)
    expect(push.exitCode).toBe(0)

    const controller = new AbortController()
    const watcherLog = join(watcher.root, '.sofar', 'initiatives', 'live', 'events.jsonl')
    const watch = runPullWatch(
      watcher.root,
      { slug: 'live' },
      { env: watcher.env, signal: controller.signal, onLine: () => {}, onWarnLine: () => {} },
      plain,
      plain,
    )
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && readEvents(watcherLog).events.length < 3) {
      await new Promise((r) => setTimeout(r, 250))
    }
    controller.abort()
    expect(await watch).toBeUndefined()
    expect(readEvents(watcherLog).events.length).toBe(3)
  }, scaled(40_000))
})
