const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync('shell/share.sh', 'utf8');
function extract(name) {
  const start = source.indexOf(name + '() {');
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-env-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'env file.sh');
  fs.writeFileSync(file, content);
  return {
    root,
    file,
    run(script) {
      const r = spawnSync(
        '/bin/bash',
        [
          '-ec',
          extract('get_env_array') +
            '\n' +
            extract('clear_env') +
            '\n' +
            script,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, file_env: file, FIXTURE_ROOT: root },
        },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    },
  };
}
test('matches legacy pipeline for whitespace, malformed lines, CRLF and final unterminated line', (t) => {
  const f = fixture(
    t,
    '# comment\nexport A=one\nexport B="two words"\n export IGNORED=1\nexport\tIGNORED2=1\nexport   C = spaced\nexport \nexport -x X=1\nexport D=a=b\nexport E=crlf\r\nexport F\r\nexport G=last',
  );
  assert.equal(
    f.run('get_env_array; printf "%s\\0" "${exported_variables[@]}"'),
    f.run(
      'while IFS= read -r line; do printf "%s\\0" "$line"; done < <(grep "^export " "$file_env" | awk \'{print $2}\' | cut -d= -f1)',
    ),
  );
});
test('resets prior names for an empty file', (t) => {
  const f = fixture(t, '');
  assert.equal(
    f.run(
      'exported_variables=(OLD); get_env_array; echo "${#exported_variables[@]}"',
    ),
    '0\n',
  );
});
test('extracting names never evaluates command substitutions or shell syntax in values', (t) => {
  const f = fixture(
    t,
    'export A=$(touch "$FIXTURE_ROOT/unsafe")\nexport B=`touch "$FIXTURE_ROOT/unsafe2"`\n',
  );
  assert.equal(
    f.run('get_env_array; printf "%s\\n" "${exported_variables[@]}"'),
    'A\nB\n',
  );
  assert.equal(fs.existsSync(path.join(f.root, 'unsafe')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'unsafe2')), false);
});
test('clear_env removes listed exports and preserves unrelated values', (t) => {
  const f = fixture(t, 'export USER_ONE=1\nexport USER_TWO=2\n');
  f.run(
    'USER_ONE=old; USER_TWO=old; UNRELATED=kept; get_env_array; clear_env; [[ ! ${USER_ONE+x} && ! ${USER_TWO+x} && "$UNRELATED" == kept ]]',
  );
});
test('large configuration preserves order and duplicate names', (t) => {
  const text = Array.from(
    { length: 5000 },
    (_, i) => 'export V' + (i % 1000) + '=value with spaces',
  ).join('\n');
  const f = fixture(t, text);
  const lines = f
    .run('get_env_array; printf "%s\\n" "${exported_variables[@]}"')
    .trim()
    .split('\n');
  assert.equal(lines.length, 5000);
  assert.deepEqual(
    lines,
    Array.from({ length: 5000 }, (_, i) => 'V' + (i % 1000)),
  );
});
