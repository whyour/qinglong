const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  rewriteMirrorSources,
  replaceMirrorUrl,
  normalizeMirror,
  mirrorWriteCommand,
} = require('../../back/shared/linuxMirror');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-issue-fixes-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

test('#2902/#2871 mirror writes are idempotent, preserve suites, security/ports/version paths and quote URLs', async (t) => {
  const original = `# http://leave.example/debian\nTypes: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://security.debian.org/debian-security\nSuites: bookworm-security\n`;
  const url = 'https://mirror.example/mirrors/debian/';
  const changed = rewriteMirrorSources(original, url);
  assert.equal(rewriteMirrorSources(changed, url), changed);
  assert.match(
    changed,
    /URIs: https:\/\/mirror.example\/mirrors\/debian-security/,
  );
  assert.match(changed, /Suites: bookworm-security/);
  assert.match(changed, /# http:\/\/leave.example\/debian/);
  assert.equal(
    replaceMirrorUrl('http://old/debian/debian/debian', url),
    'https://mirror.example/mirrors/debian',
  );
  assert.equal(
    replaceMirrorUrl('http://old/armbian/armbian', 'https://new/armbian'),
    'https://new/armbian',
  );
  assert.equal(
    replaceMirrorUrl('http://old/ubuntu-ports', 'https://new/ubuntu'),
    'https://new/ubuntu-ports',
  );
  assert.equal(
    replaceMirrorUrl('http://old/alpine/v3.22/main', 'https://new/alpine'),
    'https://new/alpine/v3.22/main',
  );
  assert.equal(
    replaceMirrorUrl('http://old/debian', 'https://new'),
    'https://new/debian',
  );
  for (const bad of [
    'file:///tmp/a',
    'http://u:p@host',
    'https://host?x=1',
    'https://host/\nanything',
  ])
    assert.throws(() => normalizeMirror(bad));
  const root = await fixture(t);
  const file = path.join(root, "quote's", 'sources');
  const command = mirrorWriteCommand(file, changed, '', 'true');
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), changed);
});

test('#2701 shell API serializes CR/LF, quotes, backslashes and colons without corrupting JSON', async () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source shell/api.sh
ql_api_request() { while [[ $# -gt 0 ]]; do if [[ "$1" == --data-raw ]]; then printf '%s\\n' "$2" >&3; break; fi; shift; done; printf '{"code":200}'; }
t() { :; }
add_cron_api '0 0 1 1 *' 'task a:b.js' $'quote"slash\\\\colon:\\r\\n\\t中文' 23
update_cron_api '0 0 1 1 *' 'task a:b.js' $'quote"slash\\\\colon:\\r\\n\\t中文' 27
update_cron_command_api $'task path\\\\with"quotes.js' 27
`,
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
  );
  assert.equal(result.status, 0, result.stderr);
  const payloads = result.output[3].trim().split('\n').map(JSON.parse);
  assert.equal(payloads[0].name, 'quote"slash\\colon:\r\n\t中文');
  assert.equal(payloads[0].sub_id, 23);
  assert.equal(payloads[1].id, '27');
  assert.equal(payloads[2].command, 'task path\\with"quotes.js');
});
