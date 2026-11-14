import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { elideHeredocs, redactCommand, REDACTED } from '../src/core/redact'

/**
 * The secret-shape corpus (security-audit 3.5, SA-08): every entry's secret
 * must be gone from the recorded command, and every negative — real command
 * shapes from this repo's own record — must come back byte-identical.
 * Vendor tokens are assembled at runtime, so no token-shaped literal sits in
 * the source for a scanner to flag.
 */

const F = 'Zq8xW2rT5yU9pL3kM7nB4vC6'
const tok = (prefix: string, n: number): string => prefix + (F + F + F).slice(0, n)

export const CORPUS: Array<[cmd: string, secret: string]> = [
  [`export GH_TOKEN=${F}`, F],
  [`curl -u admin:${F} https://x.test`, F],
  [`curl -uadmin:${F} https://x.test`, F],
  [`curl --user admin:${F} https://x.test`, F],
  [`curl --user=admin:${F} https://x.test`, F],
  [`curl -u 'admin:${F}' https://x.test`, F],
  [`wget --user=admin --password=${F} https://x.test`, F],
  [`http -a admin:${F} x.test`, F],
  [`mysql -uroot -p${F} db`, F],
  [`mysqldump -p${F} db > d.sql`, F],
  [`docker login -u me -p ${F} registry.test`, F],
  [`podman login -p ${F} quay.test`, F],
  [`echo ${F} | docker login --password-stdin -u me`, F],
  [`printf '%s' "${F}" | helm registry login --password-stdin r.test`, F],
  [`echo ${F} | sudo -S systemctl restart x`, F],
  [`sshpass -p ${F} ssh host`, F],
  [`sshpass -p${F} ssh host`, F],
  [`redis-cli -a ${F} ping`, F],
  [`openssl rsa -passin pass:${F} -in k.pem`, F],
  [`openssl enc -aes-256-cbc -k ${F} -in f`, F],
  [`zip -P ${F} out.zip f`, F],
  [`7z a -p${F} out.7z f`, F],
  [`ldapsearch -w ${F} -D cn=x`, F],
  [`curl -H 'X-Api-Key: ${F}' https://x.test`, F],
  [`curl -H "X-Auth-Token: ${F}" https://x.test`, F],
  [`curl -d '{"password":"${F}"}' https://x.test`, F],
  [`curl -d '{"api_key": "${F}"}' https://x.test`, F],
  [`curl -d '{"client_secret":"${F}","grant_type":"client_credentials"}' https://x.test`, F],
  [`echo 'password: ${F}' >> config.yml`, F],
  [`echo "  secret: ${F}" >> values.yaml`, F],
  [`STRIPE_KEY=${F} node x.js`, F],
  [`DB_PASS=${F} psql`, F],
  [`MYSQL_PWD=${F} mysql`, F],
  [`SENTRY_DSN=https://${F}@o1.ingest.sentry.test/1 npm run x`, F],
  [`az storage blob list --connection-string "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${F}==;EndpointSuffix=core"`, F],
  [`restic backup --pass ${F} .`, F],
  [`some-cli --key ${F}`, F],
  [`tool --db-pass=${F}`, F],
  [`echo "-----BEGIN RSA PRIVATE KEY-----\nMIIE${F}\n-----END RSA PRIVATE KEY-----" > k`, F],
  [`printf '%s' '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl${F}\n-----END OPENSSH PRIVATE KEY-----'`, F],
  [`cat > .env <<'EOF'\nAPI=${F}\nEOF`, F],
  [`python3 - <<EOF\nimport os\nclient(token="${F}")\nEOF\necho done`, F],
  [`git clone https://${F}1234@github.test/x/y`, F],
  [`git clone https://user:${F}@host.test/x`, F],
  [`psql postgresql://u:${F}@h.test/db`, F],
  [`mongosh "mongodb+srv://u:${F}@cluster.test"`, F],
  [`heroku config:set API_KEY=${F}`, F],
  [`kubectl create secret generic x --from-literal=password=${F}`, F],
  [`npm config set //registry.npmjs.org/:_authToken=${F}`, F],
  [`git -c http.extraheader="AUTHORIZATION: basic ${F}" fetch`, F],
  [`curl -H 'Authorization: Bearer ${F}' https://x.test`, F],
  [`cli --token ${F}`, F],
  [`AWS_SECRET_ACCESS_KEY=${F} aws s3 ls`, F],
  [`export OPENAI_API_KEY=${tok('sk-proj-', 24)}`, tok('sk-proj-', 24)],
  [`stripe x ${tok('sk_' + 'live_', 24)}`, tok('sk_' + 'live_', 24)],
  [`stripe x ${tok('sk_' + 'test_', 24)}`, tok('sk_' + 'test_', 24)],
  [`stripe x ${tok('rk_' + 'live_', 24)}`, tok('rk_' + 'live_', 24)],
  [`glab auth ${tok('gl' + 'pat-', 20)}`, tok('gl' + 'pat-', 20)],
  [`echo ${tok('np' + 'm_', 36)}`, tok('np' + 'm_', 36)],
  [`twine upload -p ${tok('py' + 'pi-', 50)}`, tok('py' + 'pi-', 50)],
  [`huggingface-cli login ${tok('h' + 'f_', 34)}`, tok('h' + 'f_', 34)],
  [`vault login ${tok('hv' + 's.', 24)}`, tok('hv' + 's.', 24)],
  [`doctl auth init -t ${tok('dop_' + 'v1_', 64)}`, tok('dop_' + 'v1_', 64)],
  [`shopify x ${tok('sh' + 'pat_', 32)}`, tok('sh' + 'pat_', 32)],
  [`linear x ${tok('lin_' + 'api_', 40)}`, tok('lin_' + 'api_', 40)],
  [`sendgrid x ${tok('S' + 'G.', 22)}.${F}`, F],
  [`aws x ${'AS' + 'IA'}ABCDEFGHIJ234567`, 'ABCDEFGHIJ234567'],
  [`gh x ${tok('gh' + 'p_', 36)}`, tok('gh' + 'p_', 36)],
  [`slack x ${tok('xo' + 'xb-', 30)}`, tok('xo' + 'xb-', 30)],
  [`aws configure set aws_secret_access_key ${F}`, F],
  [`vault kv put secret/x value=${F}`, F],
  [`htpasswd -b .htpasswd user ${F}`, F],
]

/** Bare positional secrets nothing on the line marks (SA-08's residue; the target is ≤3/70). */
const KNOWN_MISSES = new Set([
  `aws configure set aws_secret_access_key ${F}`,
  `vault kv put secret/x value=${F}`,
  `htpasswd -b .htpasswd user ${F}`,
])

export const NEGATIVES = [
  'date -u +%Y-%m-%dT%H:%M:%SZ',
  "git log --format='%H %s' -n 5",
  'git show 28fc3235a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  `sofar event append '{"session":"c9b896cb-a294-4543-b3c3-46556158f421","type":"note_added"}'`,
  'ls /Users/x/.claude/projects/-Users-x-IO-sofar/c9b896cb-a294-4543-b3c3-46556158f421.jsonl',
  'grep -rn "sk_live_" src',
  'grep -n "password:" config.ts',
  'rg "token: string" src',
  `echo '{"author": "Ada Lovelace"}'`,
  'sort --key=2,2 file',
  'ssh-add --key ~/.ssh/id_ed25519',
  'export SSH_KEY=/Users/x/.ssh/id_ed25519',
  'cat <<< "here string"',
  'echo $((1<<4))',
  `node -e "console.log(a<<b)"`,
  `curl -d '{"max_tokens": 4096}' https://x.test`,
  `echo '{"password": "string"}'`,
  'password: process.env.DB_PASSWORD',
  'curl https://api.github.com/repos/x/y',
  'git clone git@github.com:x/y.git',
  'docker run -p 8080:80 img',
  'mysql -P 3306 -u root -p db',
  'curl -u admin https://x.test',
  'redis-cli -h host ping',
  'npm_config_registry=https://r.test npm i',
  'git push origin HEAD:refs/heads/main',
  "npx vitest run -t 'heredoc: 3 lines'",
  'sofar find docs/SPEC.md',
  'gtimeout -k 30s 600s npx vitest run --project unit packages/engine/test/control-chars.test.ts',
  `echo "session_id: 01M1E74Y0000000000000000010"`,
  `echo 'ttl: 86400000'`,
  'cargo test -p sofar-core --lib -q log::',
  'git commit -m "3.3: symlink-safe writes"',
]

describe('the SA-08 corpus', () => {
  it('leaves no secret behind but the known bare positionals', () => {
    const leaks = CORPUS.filter(([cmd, secret]) => redactCommand(cmd).includes(secret)).map(([cmd]) => cmd)
    expect(leaks.filter((cmd) => !KNOWN_MISSES.has(cmd))).toEqual([])
    expect(leaks.length).toBeLessThanOrEqual(3)
    expect(CORPUS.length).toBeGreaterThanOrEqual(70)
  })

  it('changes no real command shape', () => {
    expect(NEGATIVES.filter((cmd) => redactCommand(cmd) !== cmd)).toEqual([])
  })
})

describe('heredoc elision', () => {
  it('keeps the operator line and the terminator, and counts the body', () => {
    const out = redactCommand(`git commit -F - <<'EOF'\nfirst\nsecond\nEOF\ngit push`)
    expect(out).toMatch(/^git commit -F - <<'EOF'\n\[heredoc: 2 lines, sha256:[0-9a-f]{12}\]\nEOF\ngit push$/)
  })

  it('handles <<-, two heredocs on one line, and an unterminated one', () => {
    expect(elideHeredocs('cat <<-X\n\tbody\n\tX')).toMatch(/^cat <<-X\n\[heredoc: 1 line, sha256:[0-9a-f]{12}\]\n\tX$/)
    expect(elideHeredocs('paste <<A <<B\na1\nA\nb1\nb2\nB')).toMatch(/^paste <<A <<B\n\[heredoc: 1 line, .*\]\nA\n\[heredoc: 2 lines, .*\]\nB$/)
    expect(elideHeredocs('cat <<EOF\nno end')).toBe('cat <<EOF\nno end')
    expect(elideHeredocs('cat <<EOF\nEOF')).toBe('cat <<EOF\nEOF')
  })

  it('is linear on many unterminated operators', () => {
    const cmd = `${'x <<A '.repeat(5000)}\n${'line\n'.repeat(5000)}`
    const t = performance.now()
    elideHeredocs(cmd)
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('linear time (SA-28 for the new passes)', () => {
  it('a 64 KB adversarial command redacts in well under a second', () => {
    for (const unit of ['password:', 'A_KEY=x ', 'a=', '"x', '-u ', 'https://', '<<', '-----BEGIN ', 'echo x | sudo -S ']) {
      const cmd = unit.repeat(Math.ceil(65_536 / unit.length))
      const t = performance.now()
      redactCommand(cmd)
      expect(performance.now() - t, unit).toBeLessThan(1000)
    }
  })

  it('REDACTED is the marker every pass writes', () => {
    expect(redactCommand(`mysql -p${F}`)).toBe(`mysql -p${REDACTED}`)
  })
})

describe('the cross-language fixture', () => {
  it('crates/sofar-core/tests/fixtures/js-redact.json is this engine\'s own output, so the core proves against it', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '../../../crates/sofar-core/tests/fixtures/js-redact.json'), 'utf8')) as { rows: Array<{ input: string; output: string }> }
    expect(fixture.rows.filter((r) => redactCommand(r.input) !== r.output).map((r) => r.input)).toEqual([])
    const inputs = new Set(fixture.rows.map((r) => r.input))
    expect([...CORPUS.map(([c]) => c), ...NEGATIVES].filter((c) => !inputs.has(c))).toEqual([])
  })
})
