/**
 * Host-compiled payloads (r4-fixes A2; R4-RESEARCH 1.2 O2, N2 part 1): one
 * fold, sized per host to what an always-on byte costs there. A token carried
 * for N calls costs about 3 input units on Claude, 4.3 on Codex and 17 on
 * Cursor (R4-RESEARCH lane 1.2, section 1.1), so the SessionStart digest gets a per-host budget: Claude
 * keeps the 6,000 chars it has always had, Codex gets 4,000 and Cursor 3,000.
 *
 * `SOFAR_PAYLOAD=v034` is the ablation arm: every host gets 0.34's digest, init
 * writes 0.34's AGENTS.md block, no `sofar-write` skill and no Codex
 * `enabled_tools`. Read by the hooks and by init, never by a template.
 */

/** Env switch: `SOFAR_PAYLOAD=v034` restores 0.34's payloads (the ablation arm). */
export const PAYLOAD_ENV = 'SOFAR_PAYLOAD'

export function payloadV034(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[PAYLOAD_ENV]?.trim().toLowerCase() === 'v034'
}

/** The digest's hard cap per host (chars). A host not named here gets Claude's. */
export const DIGEST_LIMITS: Readonly<Record<string, number>> = {
  'claude-code': 6_000,
  codex: 4_000,
  cursor: 3_000,
}

/** The 0.34 cap, every host's under `SOFAR_PAYLOAD=v034`. */
export const DIGEST_LIMIT_V034 = 6_000

export function digestLimit(tool: string, env: Readonly<Record<string, string | undefined>> = process.env): number {
  if (payloadV034(env)) return DIGEST_LIMIT_V034
  return DIGEST_LIMITS[tool] ?? DIGEST_LIMIT_V034
}
