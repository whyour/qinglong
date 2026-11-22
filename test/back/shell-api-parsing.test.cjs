const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs
  .readFileSync(path.resolve('shell/api.sh'), 'utf8')
  .replace(/\nget_token\s*$/, '\n');
const realJq = spawnSync('which', ['jq'], { encoding: 'utf8' }).stdout.trim();
function fixture(t) {
  assert.ok(realJq, 'jq is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-api-parse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'jq'),
    '#!/bin/bash\nprintf "call\\n" >> "$JQ_CALLS"\nexec "$REAL_JQ" "$@"\n',
    { mode: 0o755 },
  );
  const token = path.join(root, 'token.json'),
    response = path.join(root, 'response.json'),
    calls = path.join(root, 'calls');
  const run = (code) =>
    spawnSync(
      '/bin/bash',
      [
        '-euc',
        source +
          '\ncreate_token(){ __ql_token__=generated; generated=1; }; curl(){ cat "$RESPONSE_FILE"; };\n' +
          code,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          REAL_JQ: realJq,
          JQ_CALLS: calls,
          file_auth_token: token,
          RESPONSE_FILE: response,
          ql_port: '5700',
          __ql_token__: 'test-token',
        },
      },
    );
  return {
    token,
    response,
    run,
    count: () =>
      fs.existsSync(calls)
        ? fs.readFileSync(calls, 'utf8').trim().split('\n').length
        : 0,
  };
}
test('valid token cache is read with one jq and reused without generation', (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.token,
    JSON.stringify({
      value: 'header.payload.signature',
      expiration: 4102444800,
    }),
  );
  const r = f.run(
    'get_token; printf "%s:%s" "$__ql_token__" "${generated:-0}"',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'header.payload.signature:0');
  assert.equal(f.count(), 1);
});
test('expired, corrupt, missing or header-unsafe token cache refreshes under errexit', (t) => {
  const f = fixture(t);
  for (const content of [
    undefined,
    'broken',
    '{}',
    JSON.stringify({ value: 'old', expiration: 1 }),
    JSON.stringify({ value: 'old', expiration: '4102444800' }),
    JSON.stringify({ value: '', expiration: 4102444800 }),
    JSON.stringify({ value: 'bad\ninjected', expiration: 4102444800 }),
    JSON.stringify({ value: 'bad\n', expiration: 4102444800 }),
    JSON.stringify({ value: 'bad\rinjected', expiration: 4102444800 }),
  ]) {
    if (content === undefined) fs.rmSync(f.token, { force: true });
    else fs.writeFileSync(f.token, content);
    const r = f.run('get_token; printf "%s:%s" "$__ql_token__" "$generated"');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'generated:1');
  }
});
test('success with a message checks authentication and stays silent', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.response, JSON.stringify({ code: 200, message: 'ok' }));
  const r = f.run('update_cron 1 0 123 log 1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(f.count(), 2);
});
test('status and statistics errors preserve multiline Unicode messages', (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.response,
    JSON.stringify({ code: 500, message: '写入失败\n请重试 "原任务"' }),
  );
  for (const command of [
    'update_cron 1 1 123 log 1 2 7',
    'record_cron_stat 1 7 2',
  ]) {
    const r = f.run(command);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '写入失败\n请重试 "原任务"\n');
  }
  assert.equal(f.count(), 4);
});
test('non-JSON errors fall back to raw text and absent messages retain legacy null', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.response, 'upstream unavailable');
  let r = f.run('update_cron 1 0 123 log 1');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'upstream unavailable\n');
  fs.writeFileSync(f.response, '{"code":500}');
  r = f.run('record_cron_stat 1 7 2');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'null\n');
});
test('statistics without a task id perform no JSON parsing', (t) => {
  const f = fixture(t);
  const r = f.run('record_cron_stat "" 0 1 || true');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.count(), 0);
});

test('canonical success resets prior errors and matches jq missing-message semantics', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.response, '{"code":200}');
  const r = f.run(
    'code=500; message=old; ql_parse_status_response "$(cat "$RESPONSE_FILE")"; printf "%s|%s" "$code" "$message"; record_cron_stat 1 0 1',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '200|null');
  assert.equal(f.count(), 0);
});

test('noncanonical JSON always uses jq, including whitespace, duplicate keys and embedded success text', (t) => {
  const f = fixture(t);
  const cases = [
    [' {"code":200} ', '200|null'],
    ['{"code": 200}', '200|null'],
    ['{"code":200,"message":"完成\\n第二行"}', '200|完成\n第二行'],
    ['{"code":200,"data":{"code":500}}', '200|null'],
    ['{"code":"200"}', '200|null'],
    ['{"code":200,"code":500,"message":"error"}', '500|error'],
    ['{"code":500,"message":"{\\"code\\":200}"}', '500|{"code":200}'],
    ['{"code":500}', '500|null'],
  ];
  for (const [body, expected] of cases) {
    fs.writeFileSync(f.response, body);
    const r = f.run(
      'ql_parse_status_response "$(cat "$RESPONSE_FILE")"; printf "%s|%s" "$code" "$message"',
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, expected);
  }
  assert.equal(f.count(), cases.length);
});

test('success-shaped invalid documents retain the raw-response error fallback', (t) => {
  const f = fixture(t);
  const cases = [
    '{"code":200}trailing',
    '{"code":200',
    '<html>{"code":200}</html>',
  ];
  for (const body of cases) {
    fs.writeFileSync(f.response, body);
    const r = f.run('update_cron 1 0 123 log 1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, body + '\n');
  }
  assert.equal(f.count(), cases.length * 2);
});

test('Shell retries the same identified receipt after a timeout and starts the next run with a fresh ID', (t) => {
  const f = fixture(t);
  const result = f.run(`
    ID=7; unset QL_TRIGGER_ID
    curl() {
      while [[ $1 != --data-raw ]]; do shift; done
      printf '%s\n' "$2" >> "$RESPONSE_FILE"
      if [[ ! -e $RESPONSE_FILE.pending ]]; then touch "$RESPONSE_FILE.pending"; return 28; fi
      rm "$RESPONSE_FILE.pending"; printf '{"code":200}'
    }
    for execution in 1 2; do
      init_execution_id
      update_cron 7 0 "$$" same.log 100
      update_cron 7 1 "$$" same.log 100 1 5
      record_cron_stat 7 5 1
    done
  `);
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(f.response, 'utf8').trim().split('\n');
  assert.equal(lines.length, 12);
  for (let i = 0; i < lines.length; i += 2)
    assert.equal(lines[i], lines[i + 1]);
  const ids = lines.map((line) => JSON.parse(line).execution_id);
  assert.match(ids[0], /^client-[0-9a-f-]{36}$/);
  assert.ok(ids.slice(0, 6).every((id) => id === ids[0]));
  assert.ok(ids.slice(6).every((id) => id === ids[6]));
  assert.notEqual(ids[0], ids[6]);
});

test('a standalone shell reuses the observed end for both receipts, including timeout retries', (t) => {
  const f = fixture(t);
  const result = f.run(
    [
      'ql_execution_id="client-123"; directory=$(dirname "$RESPONSE_FILE");',
      'ql_api_request() {',
      '  local arg; for arg in "$@"; do case "$arg" in "X-QL-Finished-At:"*) printf "%s\\n" "$arg" >> "$directory/headers";; esac; done;',
      '  if [[ ! -e "$directory/retried" ]]; then touch "$directory/retried"; return 28; fi;',
      '  printf \'{"code":200}\';',
      '}',
      'update_cron 5 0 501 task.log 1700000000;',
      'rm -f "$directory/retried";',
      'update_cron 5 1 501 task.log 1700000000 60 17 1700000060;',
      'record_cron_stat 5 17 60 1700000060;',
      'cat "$directory/headers";',
    ].join('\n'),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.trim().split('\n'),
    Array(3).fill('X-QL-Finished-At: 1700000060000'),
  );
});
