const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
const hasApt = spawnSync('apt-get', ['--version']).status === 0;
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

for (const distribution of ['Debian', 'Ubuntu']) {
  for (const legacyContent of ['', ' \t\r\n']) {
    test(`${distribution}: empty legacy sources.list falls back to deb822 .sources`, async (t) => {
      const root = await fixture(t);
      const legacy = path.join(root, 'sources.list');
      const sources = path.join(
        root,
        'sources.list.d',
        `${distribution.toLowerCase()}.sources`,
      );
      await fs.writeFile(legacy, legacyContent);
      const util = load('back/config/util.ts', {
        'fs/promises': {
          readFile: async (file) => {
            if (file === '/etc/os-release')
              return `ID=${distribution.toLowerCase()}\nVERSION_CODENAME=${
                distribution === 'Debian' ? 'bookworm' : 'noble'
              }\n`;
            if (file === '/etc/apt/sources.list')
              return fs.readFile(legacy, 'utf8');
            throw Object.assign(new Error('missing fixture source'), {
              code: 'ENOENT',
            });
          },
        },
        os: { platform: () => 'linux' },
        './index': {},
        './const': {},
        './share': {},
        './container': { isInContainer: () => false },
        '../loaders/logger': {},
        '../shared/utils': {},
        '../shared/fileAccess': {},
        '../data/dependence': {},
      });
      const previousOS = process.env.QL_OS_TYPE;
      let command;
      try {
        process.env.QL_OS_TYPE = distribution.toLowerCase();
        command = await util.updateLinuxMirrorFile('https://mirror.example');
      } finally {
        if (previousOS === undefined) delete process.env.QL_OS_TYPE;
        else process.env.QL_OS_TYPE = previousOS;
      }
      // Execute the entire generated writer, redirecting its APT paths into
      // the fixture and replacing only the package-index refresh.
      const isolated = command
        .replaceAll('/etc/apt', root)
        .replace('apt-get update --error-on=any', 'true');
      const result = spawnSync('bash', ['-c', isolated], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await fs.readFile(legacy, 'utf8'), legacyContent);
      const generated = await fs.readFile(sources, 'utf8');
      assert.match(generated, /^Types: deb\nURIs: https:\/\/mirror\.example\//);
      assert.match(generated, /Signed-By: \/usr\/share\/keyrings\//);
      assert.match(
        generated,
        distribution === 'Debian' ? /bookworm-security/ : /noble-backports/,
      );
      if (hasApt) {
        // Parse both source locations with real APT, without refreshing indexes
        // or touching the host's configuration/cache.
        const parsed = spawnSync(
          'apt-get',
          [
            'indextargets',
            '-o',
            `Dir::Etc::sourcelist=${legacy}`,
            '-o',
            `Dir::Etc::sourceparts=${path.dirname(sources)}`,
            '-o',
            `Dir::State::lists=${path.join(root, 'lists')}`,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(parsed.status, 0, parsed.stderr);
      }
    });
  }
}

test('deb822 mirror changes preserve vendor archives, signing keys and comments across repeated saves', () => {
  const system =
    'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: bookworm\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n';
  const vendors = [
    'Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: bookworm\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n',
    'Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: bookworm\nComponents: stable\n',
    'Types: deb\nURIs: https://packages.microsoft.com/repos/code\nSuites: stable\nComponents: main\n',
    'Types: deb\nURIs: https://vendor.example/debian\nSuites: bookworm\nComponents: main\nSigned-By: /etc/apt/keyrings/vendor.gpg\n',
  ];
  const comment = '# Keep https://vendor.example/debian unchanged\n';
  const original = [system, ...vendors, comment].join('\n');
  const first = rewriteMirrorSources(
    original,
    'https://mirror.example/mirrors/debian',
  );
  assert.ok(first.includes('URIs: https://mirror.example/mirrors/debian\n'));
  for (const unchanged of [...vendors, comment])
    assert.ok(first.includes(unchanged));
  assert.equal(
    rewriteMirrorSources(first, 'https://mirror.example/mirrors/debian'),
    first,
  );
  const second = rewriteMirrorSources(first, 'https://second.example/debian');
  assert.ok(second.includes('URIs: https://second.example/debian\n'));
  for (const unchanged of [...vendors, comment])
    assert.ok(second.includes(unchanged));
});

test('legacy mirror changes preserve third-party lines, inline comments and source options', () => {
  const system =
    'deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian bookworm main # https://leave.example/debian\n';
  const security =
    'deb-src https://security.debian.org/debian-security bookworm-security main\n';
  const vendors = [
    'deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n',
    'deb https://download.docker.com/linux/debian bookworm stable\n',
    'deb [signed-by=/etc/apt/keyrings/vendor.gpg] https://vendor.example/debian bookworm main\n',
    'deb https://packages.microsoft.com/repos/code stable main\n',
    '# deb https://deb.debian.org/debian bookworm main\n',
  ];
  const original = system + security + vendors.join('');
  const changed = rewriteMirrorSources(
    original,
    'https://mirror.example/debian',
  );
  assert.ok(
    changed.includes(
      system.replace(
        'https://deb.debian.org/debian',
        'https://mirror.example/debian',
      ),
    ),
  );
  assert.ok(
    changed.includes(
      security.replace(
        'https://security.debian.org/debian-security',
        'https://mirror.example/debian-security',
      ),
    ),
  );
  for (const unchanged of vendors) assert.ok(changed.includes(unchanged));
  assert.equal(
    rewriteMirrorSources(changed, 'https://mirror.example/debian'),
    changed,
  );
});

test('Ubuntu ports, Armbian and Alpine roots still switch mirrors without altering repository metadata', () => {
  for (const url of [
    'https://ports.ubuntu.com/ubuntu-ports',
    'https://apt.armbian.com/armbian',
    'https://old.example/alpine/v3.22/main',
    'https://old.example/alpine/v3.22/community',
  ]) {
    const original = `URIs: ${url}\nSuites: noble\nComponents: main\n`;
    assert.equal(
      rewriteMirrorSources(original, 'https://mirror.example'),
      original.replace(url, replaceMirrorUrl(url, 'https://mirror.example')),
    );
  }
});
