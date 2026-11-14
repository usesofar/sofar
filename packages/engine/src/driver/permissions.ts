import { readFileSync, writeFileSync } from 'node:fs'

/**
 * The permission surface a driven session runs under (session-driver 2.4, D8).
 *
 * Unattended is the whole problem. Print mode has no one to prompt: a gated
 * tool call does not wait, it FAILS — so a session launched under the default
 * permission mode cannot edit a file, run a test or commit, and every session
 * in the run ends as a stall having done nothing. The surface is what makes a
 * driven session able to work at all, and stating it is what keeps it from
 * being able to do anything.
 *
 * It is a RUN property. `run_started.surface` records it, `--resume` takes the
 * run's recorded one over the resuming driver's flags (as it already does for
 * threshold_pct, context_window and max_sessions), and the digest can
 * therefore answer the question an unattended run raises months later: what
 * were those sessions allowed to do? A surface that lived only in a temp file
 * would be the unrecorded input drift-certification D6 closes, arriving
 * through a different door.
 *
 * What it is NOT is a sandbox. Each agent's file is one settings SOURCE among
 * the operator's own, and allow rules union across sources — sofar does not
 * restrict them, because this repo's hooks live in project settings and its
 * MCP server enablement in local settings, and a driven session cut off from
 * those could neither receive the record nor call sofar. So the surface can
 * only WIDEN what the operator's own configuration already permits. The record
 * says what sofar pinned; it never claims what the session could ultimately do.
 */

/**
 * Permission modes Claude Code accepts; the driver's default is `acceptEdits`.
 *
 * Checked against 2.1.251, whose own `--permission-mode` advertises
 * `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. `auto`
 * and `manual` are the two the list here used to be missing, and a mode sofar
 * refuses is a mode no operator can reach: the driver builds the child's argv,
 * so this list is the whole vocabulary. `default` stays because the binary
 * still accepts it — it is simply no longer advertised, and a run recorded
 * under it must remain resumable.
 *
 * The list is validated where the operator STATES a mode and trusted where the
 * record REPLAYS one (`PermissionSurface.permission_mode` is a plain string
 * for exactly that reason), so a build that falls behind the binary again
 * refuses new runs rather than refusing to resume old ones.
 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'manual',
  'bypassPermissions',
  'plan',
  'dontAsk',
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/**
 * `acceptEdits`, because an unattended session must be able to edit and a
 * prompt nobody can answer is a failure. Not `bypassPermissions`: that is
 * reachable with --permission-mode and recorded when chosen, but a driver
 * that defaulted to it would hand every unattended session the whole machine
 * for the convenience of never being asked.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits'

/**
 * The protocol floor: exactly what the driver's OWN prompt orders a session to
 * do, and nothing else. The prompt says log decisions, mark the task done,
 * write back, then commit code and record together — a session that cannot do
 * those cannot hand off, and the run stalls forever on a permission it was
 * never given.
 *
 * What the PROJECT needs to prove a task done — its test and build commands —
 * is deliberately absent. Sofar cannot know them, and a built-in table of
 * likely ones (`npm test`, `cargo test`, …) is a table it could not keep true,
 * the same reason it refuses to infer a context window from a model name. The
 * operator states those with --allow, and the record keeps what they stated.
 *
 * `git push` is absent for a different reason: it is outward-facing and the
 * prompt never orders it, so under the default mode it stays gated and fails
 * rather than being taken unattended. No deny rule is needed to make that so.
 */
export const DEFAULT_ALLOW: readonly string[] = [
  // The record half. `mcp__<server>` is the server-level rule form — every
  // sofar tool, so a tool added later needs no new rule.
  'mcp__sofar',
  'Bash(sofar:*)',
  // The commit half, local only: reading the tree is how a session knows what
  // it is about to commit.
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
]

/**
 * What no driven session may run, whatever its surface allows (security-audit
 * D3, SA-04). `Bash(sofar:*)` in the floor is for the record half; these are
 * the sofar subcommands that reach past it — start another run, rewire or
 * replace the install, open a server, move the record off the machine, or
 * loosen this clone's check gate. Written into every launch's settings file
 * beside the surface's own deny rules, never into the surface itself, so a
 * recorded surface reads exactly as it did and every run gets them. The CLI
 * refuses the same set inside a driven session (cli/drive.ts
 * drivenRefusal), which covers the adapters that take no settings file.
 */
export const DRIVEN_DENY: readonly string[] = [
  'Bash(sofar drive:*)',
  'Bash(sofar init:*)',
  'Bash(sofar uninit:*)',
  'Bash(sofar upgrade:*)',
  'Bash(sofar serve:*)',
  'Bash(sofar login:*)',
  'Bash(sofar link:*)',
  'Bash(sofar push:*)',
  'Bash(sofar pull:*)',
  'Bash(sofar check --approve:*)',
  'Bash(sofar check --block-commits:*)',
  'Bash(sofar check --strict-tests:*)',
]

/**
 * What the run pinned. Structurally IDENTICAL to the schema's `RunSurface`,
 * deliberately: the surface is written to the event and read back from the
 * fold on resume, and a second spelling would mean a conversion in both
 * directions and two places for it to drift.
 *
 * `permission_mode` is a plain string here rather than the union. It is
 * validated where the operator STATES it (`buildSurface`) and trusted where
 * the record REPLAYS it: a resumed run pins what it actually ran under, and a
 * driver refusing to resume because a newer binary renamed a mode would be
 * arguing with history.
 */
export interface PermissionSurface {
  permission_mode: string
  allow: string[]
  deny?: string[]
  /** Routing hints, recorded here so the run can say what it pinned — and what it left ambient. */
  model?: string
  effort?: string
}

export interface SurfaceOptions {
  mode?: string
  /** Rules ADDED to the floor; `bare` drops the floor and leaves only these. */
  allow?: string[]
  deny?: string[]
  /** Start from nothing instead of DEFAULT_ALLOW — the operator states the whole surface. */
  bare?: boolean
  model?: string
  effort?: string
}

export class SurfaceError extends Error {}

/**
 * The surface for a run. Rules are deduplicated in order, so an operator who
 * re-states a floor rule gets one rule and not two — the record is compared
 * on resume, and a list that differs only by a repeat would read as a
 * different surface.
 */
export function buildSurface(options: SurfaceOptions = {}): PermissionSurface {
  const mode = options.mode ?? DEFAULT_PERMISSION_MODE
  if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new SurfaceError(
      `--permission-mode must be one of ${PERMISSION_MODES.join('|')}, got "${mode}"`,
    )
  }
  const allow = dedupe([...(options.bare === true ? [] : DEFAULT_ALLOW), ...(options.allow ?? [])])
  const deny = dedupe(options.deny ?? [])
  return {
    permission_mode: mode,
    allow,
    ...(deny.length > 0 ? { deny } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
  }
}

function dedupe(rules: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rule of rules) {
    const trimmed = rule.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Two surfaces are the same when they pin the same things in the same order. */
export function sameSurface(a: PermissionSurface | undefined, b: PermissionSurface | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function canonical(s: PermissionSurface): unknown {
  return [s.permission_mode, s.allow, s.deny ?? [], s.model ?? null, s.effort ?? null]
}

/** One line for a progress stream or a status render: what this run pinned. */
export function describeSurface(s: PermissionSurface): string {
  const parts = [s.permission_mode, `${s.allow.length} allow`]
  if (s.deny !== undefined && s.deny.length > 0) parts.push(`${s.deny.length} deny`)
  if (s.model !== undefined) parts.push(`model ${s.model}`)
  if (s.effort !== undefined) parts.push(`effort ${s.effort}`)
  return parts.join(', ')
}

/**
 * Write a settings file and PROVE it landed (D8): read the bytes back, parse
 * them, and compare against what was meant to be written. A launch whose
 * surface cannot be proven does not happen — throwing here is the whole point,
 * because the alternative is a session running under a surface nobody checked,
 * which is indistinguishable from a session running under the operator's
 * ambient configuration.
 *
 * Per LAUNCH, not per run. Verification is worth exactly its recency: a file
 * written and read back when the run started says nothing about the session
 * launched two hours and six sessions later, over a tree those sessions have
 * been editing.
 */
export function writeVerifiedSettings(path: string, settings: unknown): void {
  const encoded = `${JSON.stringify(settings, null, 2)}\n`
  writeFileSync(path, encoded)
  let readBack: string
  try {
    readBack = readFileSync(path, 'utf8')
  } catch (err) {
    throw new SurfaceError(
      `settings file ${path} could not be read back after writing: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (readBack !== encoded) {
    throw new SurfaceError(
      `settings file ${path} does not hold what was written — the session's permission surface cannot be verified, so the launch is refused`,
    )
  }
}
