/**
 * What a Claude Code hook result carries, whichever form it took.
 *
 * Since session-naming D1 a SessionStart or UserPromptSubmit result whose
 * payload names no `session_title` (every test payload, unless it says
 * otherwise) hands the host the session's title, so its stdout is the
 * `hookSpecificOutput` object and the context rides under
 * `additionalContext`. A titled session — or any other host — still gets the
 * plain form. Tests that pin the CONTEXT read it through `hookContext`, so
 * they hold for both forms; tests that pin the form itself read stdout.
 */
const PREFIX = '{"hookSpecificOutput"'

interface HookSpecific {
  hookSpecificOutput: { hookEventName?: string; additionalContext?: string; sessionTitle?: string }
}

/** The context (plain stdout, or `additionalContext`), '' when there is none. */
export function hookContext(out: string | { stdout: string }): string {
  const stdout = typeof out === 'string' ? out : out.stdout
  if (!stdout.startsWith(PREFIX)) return stdout
  return (JSON.parse(stdout) as HookSpecific).hookSpecificOutput.additionalContext ?? ''
}

/** The session title handed over, or null for the plain form. */
export function hookTitle(out: string | { stdout: string }): string | null {
  const stdout = typeof out === 'string' ? out : out.stdout
  if (!stdout.startsWith(PREFIX)) return null
  return (JSON.parse(stdout) as HookSpecific).hookSpecificOutput.sessionTitle ?? null
}
