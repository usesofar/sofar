import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Claude Code peer sessions, read from the host's own session registry.
 *
 * sofar is the ADDRESSING layer here and never the transport (D1). Where a
 * collision surface already names the session it collided with, this turns
 * that id into the name Claude Code's own `SendMessage` addresses — and then
 * gets out of the way. sofar never binds the inbox socket, never posts to
 * one, and never calls a model (felt-cost D3): handing an agent an address
 * costs nothing and asks nothing of the network.
 *
 * That division is not just tidiness. Posting into the socket ourselves would
 * mean an undocumented wire format, a verification rule that only exempts a
 * session's own children, inbound controls that hold non-child posts for user
 * approval, and a delivered message billed to the user like a typed prompt.
 * Handing over a name has none of those failure modes, because the agent doing
 * the sending is already inside the host that owns the channel.
 *
 * THE REGISTRY IS UNDOCUMENTED. Claude Code writes one file per live session
 * at `~/.claude/sessions/<pid>.json` carrying — among fields we deliberately
 * ignore — the `sessionId` sofar already stores (the hook JSON's session_id is
 * the same value) and the `name` the host answers to. No published contract
 * promises that shape, so every read here is best-effort in the BD22 sense: a
 * missing directory, an unreadable file, malformed JSON, or a field that
 * changed type all resolve to "no peer", and the caller renders exactly what
 * it rendered before this module existed. Nothing downstream may become
 * correct only when a peer resolves.
 *
 * Everything reads FILES — no subprocess, matching core/git.ts. This sits on
 * the UserPromptSubmit path, inside the 100ms end-to-end shim budget
 * (speed T2), so spawning anything to answer a question a small JSON file
 * already holds would be the most expensive line in the block.
 */

/** One live Claude Code session, as the host's own registry describes it. */
export interface Peer {
  /** Claude Code's session id — the same value sofar stores as a session id. */
  sessionId: string
  /** The name `SendMessage` addresses. */
  name: string
  /** Working directory: the host's own tie-breaker when two names collide. */
  cwd: string
  /**
   * Another live peer answers to the same name. Claude Code derives a default
   * name from the working directory's folder, so several sessions in one repo
   * routinely collide, and the host disambiguates with a short identifier we
   * cannot reconstruct. A caller that renders an ambiguous name must say so
   * rather than imply the bare name will reach anyone in particular.
   */
  ambiguous: boolean
}

/**
 * Most registry files to read in one pass. The directory holds one file per
 * LIVE session, so real-world size is single digits and this never binds; it
 * exists so a host that stopped cleaning up cannot turn a hook line into an
 * unbounded directory walk. Exceeding it degrades the same way every other
 * failure here does — some peers simply do not resolve.
 */
const REGISTRY_SCAN_MAX = 128

export function registryDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR
  if (typeof configured === 'string' && configured.length > 0) {
    return join(configured, 'sessions')
  }
  return join(homedir(), '.claude', 'sessions')
}

interface RegistryEntry {
  sessionId: string
  name: string
  cwd: string
  pid: number
}

/**
 * Parse one registry file, or null. Every field is checked at its use type
 * rather than trusted from the cast: this is a foreign format that can change
 * under us, and a shape drift must read as "no peer", never as a crash on a
 * hook path or an `undefined` rendered into an agent-facing line.
 */
function readEntry(path: string): RegistryEntry | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const rec = raw as Record<string, unknown>
    const { sessionId, name, cwd, pid } = rec
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    if (typeof name !== 'string' || name.length === 0) return null
    if (typeof cwd !== 'string') return null
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    return { sessionId, name, cwd, pid }
  } catch {
    return null
  }
}

/**
 * Is the registered process still there? A session killed rather than exited
 * leaves its file behind, and addressing a dead peer spends the agent's turn
 * on a message nobody will read. Signal 0 sends nothing — it only asks whether
 * the pid is addressable — so this stays the no-subprocess check the rest of
 * the module is.
 *
 * PID reuse could in principle answer yes for an unrelated process. It does
 * not matter here: callers only ask about session ids the FOLD already counts
 * as live, so this is a second, independent liveness signal narrowing an
 * already-narrow set, and its worst case is one un-actionable name in a hint.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Every live peer the registry knows about. Empty whenever the registry is
 * absent, unreadable, or shaped differently than expected — the caller cannot
 * distinguish those cases, and deliberately so: all four mean the same thing
 * at the surface, which is that no address gets rendered.
 */
export function livePeers(env: Record<string, string | undefined> = process.env): Peer[] {
  const dir = registryDir(env)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const entries: RegistryEntry[] = []
  for (const file of files.slice(0, REGISTRY_SCAN_MAX)) {
    const entry = readEntry(join(dir, file))
    if (entry !== null && alive(entry.pid)) entries.push(entry)
  }

  // Ambiguity is a property of the whole live set, not of the subset a caller
  // happens to ask about: a name that reaches two sessions is ambiguous even
  // when only one of them collided with us.
  const byName = new Map<string, number>()
  for (const e of entries) byName.set(e.name, (byName.get(e.name) ?? 0) + 1)

  return entries.map((e) => ({
    sessionId: e.sessionId,
    name: e.name,
    cwd: e.cwd,
    ambiguous: (byName.get(e.name) ?? 0) > 1,
  }))
}

/**
 * Peers for the given session ids, keyed by session id. Ids with no live
 * registry entry are simply absent from the map — the caller renders those
 * exactly as it did before, naming the session without an address.
 */
export function resolvePeers(
  sessionIds: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Map<string, Peer> {
  if (sessionIds.length === 0) return new Map()
  const wanted = new Set(sessionIds)
  const found = new Map<string, Peer>()
  for (const peer of livePeers(env)) {
    if (wanted.has(peer.sessionId)) found.set(peer.sessionId, peer)
  }
  return found
}
