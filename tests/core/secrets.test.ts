import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../../src/core/secrets.ts'
import { redact } from '../../src/mod/record-events.ts'

test('URL userinfo keeps the user and blanks the password', () => {
  assert.equal(redactSecrets('git clone https://rob:Hunter2pass@dev.azure.com/org'), 'git clone https://rob:[redacted]@dev.azure.com/org')
})

test('secret-sounding keys, with = or :, blank only the value', () => {
  assert.equal(redactSecrets('password=S3cretPass!'), 'password=[redacted]')
  assert.equal(redactSecrets('DB_PASSWD: hunter2 next'), 'DB_PASSWD: [redacted] next')
  for (const k of ['pwd', 'secret', 'token', 'api_key', 'api-key', 'apikey', 'API_KEY']) assert.equal(redactSecrets(`${k}=abc`), `${k}=[redacted]`, k)
})

test('Authorization Bearer and Basic values are blanked, by the server and the recorder', () => {
  assert.equal(redactSecrets('Authorization: Bearer abc123.def456'), 'Authorization: Bearer [redacted]')
  assert.equal(redactSecrets('authorization=basic dXNlcjpwYXNz'), 'authorization=basic [redacted]')
  assert.equal(redact('Authorization: Bearer abc123.def456'), 'Authorization: Bearer [redacted]')
})

test('ordinary text is left alone', () => {
  for (const s of ['exit=1', 'count=3 retries: 4', 'see https://example.com/a/b?x=1', 'user@host:path', 'Authorization header missing', 'tests/a.test.ts:41 expected 3 tokens, got 2 keys']) {
    assert.equal(redactSecrets(s), s, s)
  }
})

test('long hyphenated runs redact in linear time (no backtracking blow-up)', () => {
  for (const unit of ['a-token', 'a-password', 'x-api-key', 'a-secret-']) {
    const text = unit.repeat(Math.ceil(65_536 / unit.length))
    const started = performance.now()
    redactSecrets(text)
    redact(text)
    assert.ok(performance.now() - started < 1000, `${unit} x 64 KB took ${Math.round(performance.now() - started)} ms`)
  }
  assert.match(redactSecrets('DB_PASSWORD: hunter2'), /DB_PASSWORD: \[redacted\]/)
  assert.match(redactSecrets('my-api-key=abc'), /my-api-key=\[redacted\]/)
})

test('redacting twice changes nothing more', () => {
  const once = redactSecrets('https://rob:Hunter2pass@h/x password=S3cretPass! Authorization: Bearer abc.def')
  assert.equal(redactSecrets(once), once)
})
