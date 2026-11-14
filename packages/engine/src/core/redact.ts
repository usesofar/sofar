import { createHash } from 'node:crypto'

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
    // security-audit 3.5 adds vendor prefixes, each needing ≥16 token
    // characters after it, so a bare `sk_live_` in a grep stays.
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sfr_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{16,}|hvs\.[A-Za-z0-9_-]{16,}|dop_v1_[A-Za-z0-9]{16,}|shp(?:at|ss|ca)_[A-Za-z0-9]{16,}|lin_api_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_.-]{16,}|ASIA[0-9A-Z]{16})/g,
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
  return redactCommandText(elideHeredocs(cmd))
}

/**
 * `redactCommand` with here-document bodies KEPT (security-audit 3.5): what
 * the PostToolUse hook matches guards and shell writes against, so heredoc
 * elision changes what the record holds and never what a live session is
 * told. Every other rule still runs, bodies included.
 */
export function redactCommandText(cmd: string): string {
  let out = redactPem(cmd)
  for (const { re, replace } of RULES) out = out.replace(re, replace)
  if (!SCAN_HINT.test(out)) return out
  const kv = replaceAll(Array.from(out), ruleKeyValue)
  return replaceAll(applyEdits(kv, argvEdits(kv)), ruleUrlUser).join('')
}

// ---------------------------------------------------------------------------
// security-audit 3.5 (SA-08): heredoc elision, PEM, key/value syntax, argv
// context rules and token-only URL users. Hand-written linear scanners over
// code points, mirrored one for one by the core's redact.rs — so no
// backtracking, and one fixture proves both.

/** Cheap pre-check: every scanned pass needs one of these (a separator, a flag or a URL). */
const SCAN_HINT = /[:=@-]/

const plural = (n: number): string => `${n} line${n === 1 ? '' : 's'}`

/** The delimiters of the here-documents a line opens, in order: `<<WORD`, `<<-'WORD'`, `<<"WORD"`, `<<\\WORD`; never `<<<`. */
function heredocOps(line: string): Array<{ word: string; dash: boolean }> {
  const ops: Array<{ word: string; dash: boolean }> = []
  let i = 0
  while (i < line.length - 1) {
    if (line[i] !== '<' || line[i + 1] !== '<') {
      i++
      continue
    }
    if (line[i + 2] === '<') {
      i += 3
      while (line[i] === '<') i++
      continue
    }
    let j = i + 2
    const dash = line[j] === '-'
    if (dash) j++
    while (line[j] === ' ' || line[j] === '\t') j++
    const q = line[j]
    let word = ''
    if (q === "'" || q === '"') {
      const close = line.indexOf(q, j + 1)
      if (close > j + 1) {
        word = line.slice(j + 1, close)
        j = close + 1
      }
    } else {
      if (q === '\\') j++
      const start = j
      if (j < line.length && isIdentStart(line.charCodeAt(j))) {
        j++
        while (j < line.length && isWordCode(line.charCodeAt(j))) j++
        word = line.slice(start, j)
      }
    }
    if (word.length > 0) ops.push({ word, dash })
    i = Math.max(j, i + 2)
  }
  return ops
}

const stripTabs = (line: string): string => line.replace(/^\t+/, '')

/**
 * Here-document bodies replaced by `[heredoc: N lines, sha256:<12 hex>]`
 * (security-audit 3.5): they were 57% of recorded command bytes and the
 * likeliest carrier of a pasted secret, and nothing reads them — guard
 * matching, test-shape detection and the last-test suite read the command
 * line only. The operator line and the terminator stay, so the command still
 * reads as what it was. A delimiter with no terminator line elides nothing.
 */
export function elideHeredocs(cmd: string): string {
  if (!cmd.includes('<<')) return cmd
  const lines = cmd.split('\n')
  // line text → the indices holding it, built once so a run of unterminated
  // `<<` operators stays linear.
  let exact: Map<string, number[]> | null = null
  let tabbed: Map<string, number[]> | null = null
  const index = (key: (l: string) => string): Map<string, number[]> => {
    const m = new Map<string, number[]>()
    lines.forEach((l, k) => {
      const t = key(l)
      const at = m.get(t)
      if (at === undefined) m.set(t, [k])
      else at.push(k)
    })
    return m
  }
  const firstAtOrAfter = (at: number[] | undefined, from: number): number => {
    if (at === undefined) return -1
    let lo = 0
    let hi = at.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (at[mid]! < from) lo = mid + 1
      else hi = mid
    }
    return lo < at.length ? at[lo]! : -1
  }
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    out.push(line)
    i++
    for (const op of heredocOps(line)) {
      if (i >= lines.length) break
      let t: number
      if (op.dash) {
        tabbed ??= index(stripTabs)
        t = firstAtOrAfter(tabbed.get(op.word), i)
      } else {
        exact ??= index((l) => l)
        t = firstAtOrAfter(exact.get(op.word), i)
      }
      if (t < 0) continue
      if (t > i) {
        const body = lines.slice(i, t).join('\n')
        out.push(`[heredoc: ${plural(t - i)}, sha256:${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)}]`)
      }
      out.push(lines[t]!)
      i = t + 1
    }
  }
  return out.join('\n')
}

const PEM_BEGIN = '-----BEGIN '
const PEM_END = '-----END '
const PEM_TAIL = 'PRIVATE KEY'

/** `[A-Z ]*PRIVATE KEY-----` at `at`: the index after it, or -1. */
function pemLabelEnd(s: string, at: number): number {
  let j = at
  while (j < s.length && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || s[j] === ' ')) j++
  return j - at >= PEM_TAIL.length && s.slice(j - PEM_TAIL.length, j) === PEM_TAIL && s.startsWith('-----', j) ? j + 5 : -1
}

/** PEM private key blocks → `[redacted]` — the prose rule, now also on commands (security-audit 3.5). */
export function redactPem(s: string): string {
  if (!s.includes(PEM_BEGIN)) return s
  let out = ''
  let from = 0
  let p = s.indexOf(PEM_BEGIN)
  while (p >= 0) {
    const head = pemLabelEnd(s, p + PEM_BEGIN.length)
    if (head < 0) {
      p = s.indexOf(PEM_BEGIN, p + 1)
      continue
    }
    let end = -1
    let q = s.indexOf(PEM_END, head)
    while (q >= 0 && end < 0) {
      end = pemLabelEnd(s, q + PEM_END.length)
      if (end < 0) q = s.indexOf(PEM_END, q + 1)
    }
    if (end < 0) break // no END after this BEGIN, so none after any later one either
    out += s.slice(from, p) + REDACTED
    from = end
    p = s.indexOf(PEM_BEGIN, end)
  }
  return out + s.slice(from)
}

const isWordCode = (n: number): boolean => (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 95
const isIdentStart = (n: number): boolean => (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 95
const isWordC = (c: string | undefined): boolean => c !== undefined && c.length === 1 && isWordCode(c.charCodeAt(0))
const isNameC = (c: string | undefined): boolean => c === '-' || isWordC(c)
const isDigitC = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isJsWs = (c: string | undefined): boolean => c !== undefined && /^\s$/.test(c)
const isSpTab = (c: string | undefined): boolean => c === ' ' || c === '\t'
const isSchemeC = (c: string | undefined): boolean => c !== undefined && c !== '_' && (isWordC(c) || c === '+' || c === '.' || c === '-')

type Matcher = (s: readonly string[], i: number) => { end: number; text: string } | null

function replaceAll(s: readonly string[], matcher: Matcher): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const m = matcher(s, i)
    if (m !== null && m.end > i) {
      out.push(...Array.from(m.text))
      i = m.end
    } else {
      out.push(s[i]!)
      i++
    }
  }
  return out
}

const upper = (s: readonly string[], from: number, to: number): string => s.slice(from, to).join('').toUpperCase()

/**
 * Names whose value is a credential in `name: value` / `"name": "value"`
 * syntax: the name must END in one of these (`GH_TOKEN`, `authToken`,
 * `client_secret`), so `input_tokens`, `token_count` and `password_hash` stay.
 * Narrower than SECRET_WORDS: no AUTH (author), SESSION (session ids), OTP or
 * COOKIE.
 */
const KV_WORDS = ['TOKEN', 'SECRET', 'PASSWD', 'PASSWORD', 'CREDENTIAL', 'CREDENTIALS', 'APIKEY', 'PRIVATEKEY', 'ACCESSKEY', 'ACCOUNTKEY']
const KV_SUFFIXES = ['KEY', 'PASS', 'PWD', 'DSN']

function kvName(name: string, flag: boolean): boolean {
  const squashed = name.replace(/[-_]/g, '')
  if (KV_WORDS.some((w) => squashed.endsWith(w))) return true
  for (const suffix of KV_SUFFIXES) {
    if (name === suffix) return flag || suffix !== 'KEY'
    if (name.length > suffix.length && name.endsWith(suffix)) {
      const sep = name[name.length - suffix.length - 1]
      if (sep === '_' || sep === '-') return true
    }
  }
  return false
}

/**
 * The value after a key/value separator: a quoted run with no whitespace
 * (`"abc"`), else an unquoted run up to whitespace or `, ; ' " ) ] }` — so a
 * quote that closes an enclosing string is never read as the value's own.
 */
function kvValueEnd(s: readonly string[], i: number): number {
  const q = s[i]
  if (q === '"' || q === "'") {
    for (let j = i + 1; j < s.length && !isJsWs(s[j]); j++) {
      if (s[j] === q) return j + 1
      if (s[j] === '\\') j++ // `\"` inside JSON is not the closing quote
    }
    return -1
  }
  let j = i
  while (j < s.length && !isJsWs(s[j]) && !KV_STOP.includes(s[j]!)) j++
  return j > i ? j : -1
}

const KV_STOP = `,;'")]}`

/** A value worth redacting: ≥8 characters, not already redacted, not a reference, a path or a bare identifier. */
function secretValue(v: readonly string[]): boolean {
  if (v.length < 8) return false
  if (v.join('').includes(REDACTED)) return false
  const first = v[0]!
  if ('$<{%/~.'.includes(first)) return false
  return !v.every((c) => isDigitC(c) === false && (/^[A-Za-z]$/.test(c) || '_.-()[]'.includes(c)))
}

/**
 * `i` opens a name run: the character before is no name character, or it is
 * the leading dashes of a flag (`--db-pass`). Starting only there keeps the
 * scan linear — `a-a-a-…` holds one name run, not one per letter.
 */
function nameHead(s: readonly string[], i: number): boolean {
  let k = i - 1
  while (s[k] === '-') k--
  return !isNameC(s[k])
}

/** `NAME: value`, `"name": "value"`, `NAME=value` and `--name value` for credential names (security-audit 3.5). */
const ruleKeyValue: Matcher = (s, i) => {
  let q = ''
  let ns = i
  if (s[i] === '"' || s[i] === "'") {
    q = s[i]!
    ns = i + 1
  } else if (!isWordC(s[i]) || !nameHead(s, i)) return null
  let ne = ns
  while (ne < s.length && isNameC(s[ne])) ne++
  if (ne === ns || (q !== '' && s[ne] !== q)) return null
  const flag = q === '' && s[i - 1] === '-'
  if (!kvName(upper(s, ns, ne), flag)) return null
  let j = q === '' ? ne : ne + 1
  const afterName = j
  while (isSpTab(s[j])) j++
  let sepEnd: number
  if (s[j] === ':' || s[j] === '=') {
    sepEnd = j + 1
    while (isSpTab(s[sepEnd])) sepEnd++
  } else if (flag && j > afterName) sepEnd = j
  else return null
  const end = kvValueEnd(s, sepEnd)
  if (end < 0) return null
  const vq = s[sepEnd] === '"' || s[sepEnd] === "'" ? s[sepEnd]! : ''
  const quoted = vq !== '' && end - sepEnd >= 2 && s[end - 1] === vq
  const inner = quoted ? s.slice(sepEnd + 1, end - 1) : s.slice(sepEnd, end)
  if (!secretValue(inner)) return null
  return { end, text: `${s.slice(i, sepEnd).join('')}${quoted ? `${vq}${REDACTED}${vq}` : REDACTED}` }
}

/** `scheme://<token>@host` with no password: a user part of ≥20 token characters holding a digit IS the credential (security-audit 3.5). */
const ruleUrlUser: Matcher = (s, i) => {
  if (isSchemeC(s[i - 1]) || s[i - 1] === '_' || s[i] === undefined || !/^[A-Za-z]$/.test(s[i]!)) return null
  let j = i + 1
  while (j < s.length && isSchemeC(s[j])) j++
  if (s[j] !== ':' || s[j + 1] !== '/' || s[j + 2] !== '/') return null
  const u = j + 3
  let k = u
  let digit = false
  while (k < s.length && (isWordC(s[k]) || s[k] === '-')) {
    if (isDigitC(s[k])) digit = true
    k++
  }
  if (k - u < 20 || !digit || s[k] !== '@') return null
  return { end: k + 1, text: `${s.slice(i, u).join('')}${REDACTED}@` }
}

interface Word {
  start: number
  end: number
}

interface Segment {
  words: Word[]
  /** Ended by a single `|`: its output is the next segment's input. */
  pipe: boolean
}

/**
 * The one shell tokenizer the argv rules read: words split on unquoted
 * spaces and tabs, segments on unquoted `|`, `&`, `;`, newline, parentheses
 * and backticks. Quotes and backslashes keep a word whole. Linear.
 */
function segments(s: readonly string[]): Segment[] {
  const segs: Segment[] = []
  let words: Word[] = []
  let ws = -1
  let q = ''
  const endWord = (e: number): void => {
    if (ws >= 0) words.push({ start: ws, end: e })
    ws = -1
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (q !== '') {
      if (c === q) q = ''
      else if (q === '"' && c === '\\') i++
      i++
      continue
    }
    if (c === '\\') {
      if (ws < 0) ws = i
      i += 2
      continue
    }
    if (c === '"' || c === "'") {
      if (ws < 0) ws = i
      q = c
      i++
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord(i)
      i++
      continue
    }
    if ('|&;\n()`'.includes(c)) {
      endWord(i)
      segs.push({ words, pipe: c === '|' && s[i + 1] !== '|' && s[i - 1] !== '|' })
      words = []
      i++
      continue
    }
    if (ws < 0) ws = i
    i++
  }
  endWord(Math.min(i, s.length))
  segs.push({ words, pipe: false })
  return segs
}

/** A word's text with its quotes and backslashes removed. */
function unquote(s: readonly string[], w: Word): string {
  let out = ''
  let q = ''
  for (let i = w.start; i < w.end; i++) {
    const c = s[i]!
    if (q !== '') {
      if (c === q) q = ''
      else if (q === '"' && c === '\\' && i + 1 < w.end) out += s[++i]!
      else out += c
    } else if (c === '"' || c === "'") q = c
    else if (c === '\\' && i + 1 < w.end) out += s[++i]!
    else out += c
  }
  return out
}

const WRAPPERS = new Set(['sudo', 'env', 'exec', 'command', 'time', 'nohup'])

/** The index of the segment's program word, past assignments and wrappers; -1 when none. */
function programAt(s: readonly string[], words: readonly Word[]): number {
  let wrapped = false
  for (let k = 0; k < words.length; k++) {
    const text = unquote(s, words[k]!)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) continue
    if (wrapped && text.startsWith('-')) continue
    const base = text.slice(text.lastIndexOf('/') + 1)
    if (WRAPPERS.has(base)) {
      wrapped = true
      continue
    }
    return k
  }
  return -1
}

const programName = (s: readonly string[], w: Word): string => {
  const text = unquote(s, w)
  return text.slice(text.lastIndexOf('/') + 1)
}

interface Edit {
  start: number
  end: number
}

const CURL = new Set(['curl', 'wget', 'http', 'https', 'xh'])
const MYSQL = new Set(['mysql', 'mariadb', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlshow', 'mysqlcheck'])
const LOGIN = new Set(['docker', 'podman', 'nerdctl', 'helm', 'buildah', 'skopeo', 'oras', 'crane'])
const LDAP = new Set(['ldapsearch', 'ldapadd', 'ldapmodify', 'ldapdelete', 'ldapwhoami', 'ldappasswd'])

/**
 * Secrets that only an argv position marks (security-audit 3.5): `curl -u
 * user:pw`, `mysql -pPW`, `docker login -p PW`, `sshpass -p PW`, `redis-cli
 * -a PW`, `openssl -passin pass:PW`, `zip -P PW`, `ldapsearch -w PW`, and an
 * `echo PW |` feeding `--password-stdin` or `sudo -S`. Scoped to the program, so `date -u`
 * stays.
 */
function argvEdits(s: readonly string[]): Edit[] {
  const edits: Edit[] = []
  const segs = segments(s)
  const text = (w: Word | undefined): string => (w === undefined ? '' : s.slice(w.start, w.end).join(''))
  const whole = (w: Word | undefined): void => {
    if (w !== undefined && !text(w).includes(REDACTED)) edits.push({ start: w.start, end: w.end })
  }
  /** The part of `w` from `from` on, inside its quotes. */
  const tail = (w: Word | undefined, from: number): void => {
    if (w === undefined || from >= w.end) return
    const q = s[w.start]
    const end = (q === '"' || q === "'") && w.end - w.start >= 2 && s[w.end - 1] === q ? w.end - 1 : w.end
    if (from < end && !s.slice(from, end).join('').includes(REDACTED)) edits.push({ start: from, end })
  }
  /** `user:pw` → the part after the first colon. */
  const userPass = (w: Word | undefined, from: number): void => {
    if (w === undefined) return
    for (let k = from; k < w.end; k++) {
      if (s[k] === ':') return tail(w, k + 1)
    }
  }
  /** The previous segment pipes `echo PW` / `printf PW` into this one's stdin: redact what it prints. */
  const stdinFeed = (n: number): void => {
    if (n === 0 || !segs[n - 1]!.pipe) return
    const feed = segs[n - 1]!
    const fp = programAt(s, feed.words)
    const fprog = fp < 0 ? '' : programName(s, feed.words[fp]!)
    if (fprog === 'echo' || fprog === 'printf') {
      for (const a of feed.words.slice(fp + 1)) if (!text(a).startsWith('-')) whole(a)
    }
  }
  segs.forEach((seg, n) => {
    const p = programAt(s, seg.words)
    if (p < 0) return
    // `sudo -S` reads the password from stdin, as `--password-stdin` does.
    let sudo = false
    for (const w of seg.words.slice(0, p)) {
      const t = text(w)
      if (programName(s, w) === 'sudo') sudo = true
      else if (sudo && (t === '-S' || t === '--stdin' || (/^-[A-Za-z]+$/.test(t) && t.includes('S')))) {
        stdinFeed(n)
        break
      }
    }
    const prog = programName(s, seg.words[p]!)
    const args = seg.words.slice(p + 1)
    const login = LOGIN.has(prog) && args.some((w) => text(w) === 'login')
    for (let k = 0; k < args.length; k++) {
      const w = args[k]!
      const t = text(w)
      const next = args[k + 1]
      if (CURL.has(prog)) {
        if (t === '-u' || t === '--user' || (prog !== 'curl' && prog !== 'wget' && t === '-a')) userPass(next, next?.start ?? 0)
        else if (t.startsWith('--user=')) userPass(w, w.start + 7)
        else if (prog === 'curl' && t.startsWith('-u') && t.length > 2) userPass(w, w.start + 2)
      } else if (MYSQL.has(prog)) {
        if (t.startsWith('-p') && t.length > 2) tail(w, w.start + 2)
      } else if (login) {
        if (t === '-p') whole(next)
      } else if (prog === 'sshpass') {
        if (t === '-p') whole(next)
        else if (t.startsWith('-p') && t.length > 2) tail(w, w.start + 2)
      } else if (prog === 'redis-cli') {
        if (t === '-a') whole(next)
      } else if (prog === 'openssl') {
        if (t === '-passin' || t === '-passout' || t === '-pass') {
          if (next !== undefined && unquote(s, next).startsWith('pass:')) {
            const colon = s.indexOf(':', next.start)
            tail(next, colon + 1)
          }
        } else if (t === '-k') whole(next)
      } else if (prog === 'zip' || prog === 'unzip') {
        if (t === '-P') whole(next)
      } else if (prog === '7z' || prog === '7za') {
        if (t.startsWith('-p') && t.length > 2) tail(w, w.start + 2)
      } else if (LDAP.has(prog)) {
        if (t === '-w') whole(next)
      }
      if (t === '--password-stdin') stdinFeed(n)
    }
  })
  return edits
}

function applyEdits(s: readonly string[], edits: readonly Edit[]): string[] {
  if (edits.length === 0) return [...s]
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: string[] = []
  let at = 0
  for (const e of sorted) {
    if (e.start < at) continue
    out.push(...s.slice(at, e.start), ...Array.from(REDACTED))
    at = e.end
  }
  out.push(...s.slice(at))
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
