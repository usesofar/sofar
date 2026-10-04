/**
 * Secret redaction for recorded command text (security-hardening 3.1).
 *
 * PostToolUse records the Bash command verbatim as `command_run{cmd}`. That
 * text lands in events.jsonl, which is committed, and — once the repo is
 * linked — pushed to the server. The log is append-only by design (BD5: events
 * are truth), so a secret that reaches it cannot be edited back out; it can
 * only be rewritten out of git history by everyone who ever cloned. The one
 * moment where it can still be stopped is before the append.
 *
 * The bias is deliberate: over-redacting costs a `[redacted]` in prose nobody
 * reads closely, and under-redacting costs a live credential in a shared,
 * permanent, replicated file. So this matches on the SHAPE of a secret-bearing
 * argument rather than trying to recognize individual vendors' formats — an
 * unknown provider's token is exactly the one no allowlist would catch.
 */

export const REDACTED = '[redacted]'

/**
 * Variable/flag names whose VALUE is a credential. Substring-matched against
 * the name, so AWS_SECRET_ACCESS_KEY, GH_TOKEN, npm_config_otp and
 * MY_COMPANY_PRIVATE_KEY are all covered without enumerating them.
 */
// `[_-]?` between words so api-key, api_key and apikey are one rule — a flag
// spelled with a hyphen is the same secret as an env var spelled with an
// underscore, and only one of those spellings would ever be guessed.
const SECRET_WORDS = [
  'TOKEN',
  'SECRET',
  'PASSWD',
  'PASSWORD',
  'API[_-]?KEY',
  'PRIVATE[_-]?KEY',
  'ACCESS[_-]?KEY',
  'CREDENTIAL',
  'AUTH',
  'OTP',
  'SESSION',
  'COOKIE',
  'BEARER',
].join('|')
const SECRET_NAME = `(?:[A-Za-z0-9_-]*(?:${SECRET_WORDS})[A-Za-z0-9_-]*)`

/** A value as it appears on a command line: quoted, or an unquoted run. */
const VALUE = `(?:"[^"]*"|'[^']*'|\\S+)`

const RULES: Array<{ re: RegExp; replace: string }> = [
  // NAME=value — env assignment or inline prefix. `export FOO_TOKEN=abc`.
  { re: new RegExp(`\\b(${SECRET_NAME})=${VALUE}`, 'gi'), replace: `$1=${REDACTED}` },
  // --flag=value and --flag value (also -p value, --otp 123456).
  { re: new RegExp(`(--?${SECRET_NAME})(=|\\s+)${VALUE}`, 'gi'), replace: `$1$2${REDACTED}` },
  // Authorization / Proxy-Authorization headers, with or without a scheme.
  {
    re: /\b((?:proxy-)?authorization\s*:\s*)(?:(bearer|basic|token|digest)\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi,
    replace: `$1$2 ${REDACTED}`,
  },
  // Credentials embedded in a URL: https://user:pw@host.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, replace: `$1:${REDACTED}@` },
  // Recognizable standalone token shapes, which travel as bare arguments and
  // so match none of the rules above.
  {
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sfr_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
    replace: REDACTED,
  },
]

/**
 * Redact credential-shaped material from a command line.
 *
 * Structure is preserved — the reader still sees `AWS_SECRET_ACCESS_KEY=` and
 * `curl -H 'Authorization: Bearer'`, which is the part that explains what the
 * command did. Only the value goes.
 */
export function redactCommand(cmd: string): string {
  let out = cmd
  for (const { re, replace } of RULES) out = out.replace(re, replace)
  return out
}

/**
 * Prose rules (r3-fixes 2.9, D6): the RULES above minus the two that read a
 * command line's grammar into ordinary words. A flag must start a word here
 * (`re-authenticate the user` is not `-authenticate <value>`), and a header
 * needs its scheme (`Authorization: we need sign-off` is a sentence). Private
 * key blocks are added: a prompt is where one gets pasted whole.
 */
const PROSE_RULES: Array<{ re: RegExp; replace: string }> = [
  RULES[0]!,
  { re: new RegExp(`(^|\\s)(--?${SECRET_NAME})(=|[ \\t]+)${VALUE}`, 'gi'), replace: `$1$2$3${REDACTED}` },
  { re: /\b((?:proxy-)?authorization\s*:\s*)(bearer|basic|token|digest)\s+(?:"[^"]*"|'[^']*'|\S+)/gi, replace: `$1$2 ${REDACTED}` },
  RULES[3]!,
  RULES[4]!,
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
]

/**
 * Redact credential-shaped material from the operator's prose before it
 * enters the committed record — the deterministic scrub a kept prompt passes
 * (r3-fixes 2.9, D6). Same bias as redactCommand: a `[redacted]` in a brief
 * costs less than a live credential in an append-only, replicated log.
 */
export function redactProse(text: string): string {
  let out = text
  for (const { re, replace } of PROSE_RULES) out = out.replace(re, replace)
  return out
}
