const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const load = require('../helpers/load-security-module.cjs');

async function fixture(t, sameHome = false, missingUser = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-ssh-home-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userHome = path.join(directory, 'user');
  const envHome = sameHome ? userHome : path.join(directory, 'env');
  const sshdPath = path.join(directory, 'ssh.d');
  await fs.mkdir(sshdPath);
  const util = {
    fileExist: async (file) =>
      fs.stat(file).then(
        () => true,
        () => false,
      ),
    rmPath: async (file) => fs.rm(file, { force: true }),
  };
  const { writeFileWithLock } = load('back/shared/utils.ts', {
    '../config/util': util,
  });
  let initialized;
  const ready = new Promise((resolve) => (initialized = resolve));
  const SshKeyService = load('back/services/sshKey.ts', {
    os: {
      ...os,
      homedir: () => envHome,
      userInfo: () => {
        if (missingUser) throw Error('No passwd entry');
        return { homedir: userHome };
      },
    },
    '../config': { sshdPath },
    '../config/util': util,
    '../shared/utils': {
      writeFileWithLock: async (file, content, options) => {
        await writeFileWithLock(file, content, options);
        if (content.includes('Include ')) {
          initialized();
        }
      },
    },
  }).default;
  const service = new SshKeyService({ error: assert.fail, warn: assert.fail });
  await ready;
  return { service, userHome, envHome, sshdPath };
}

for (const sameHome of [false, true]) {
  test(`SSH configuration uses the effective user home with ${
    sameHome ? 'matching' : 'overridden'
  } HOME`, async (t) => {
    const { service, userHome, envHome, sshdPath } = await fixture(t, sameHome);
    const configFile = path.join(userHome, '.ssh/config');
    assert.equal(
      await fs.readFile(configFile, 'utf8'),
      `Include ${sshdPath}/*.config\n\n`,
    );
    assert.equal((await fs.stat(path.dirname(configFile))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
    if (!sameHome)
      await assert.rejects(fs.stat(path.join(envHome, '.ssh/config')), {
        code: 'ENOENT',
      });
    await fs.appendFile(
      configFile,
      'Host existing\n    Hostname example.com\n',
    );
    await service.initSshConfigFile();
    const content = await fs.readFile(configFile, 'utf8');
    assert.equal(content.split('Include ').length, 2);
    assert.match(content, /Host existing/);
  });
}

test('SSH initialization still works for a custom UID without a passwd entry', async (t) => {
  const { envHome, sshdPath } = await fixture(t, true, true);
  assert.equal(
    await fs.readFile(path.join(envHome, '.ssh/config'), 'utf8'),
    `Include ${sshdPath}/*.config\n\n`,
  );
});

test('SSH alias changes retain private key permissions and remove old credentials', async (t) => {
  const { service, sshdPath } = await fixture(t);
  const {
    getSubscriptionSshAlias,
  } = require('../../back/shared/subscriptionPath');
  const original = 'private/中文@v1';
  const renamed = 'renamed/中文@v2';
  await service.addSSHKey('fixture-private-key', original, '127.0.0.1');
  const first = getSubscriptionSshAlias(original);
  assert.equal((await fs.stat(path.join(sshdPath, first))).mode & 0o777, 0o400);
  assert.match(
    await fs.readFile(path.join(sshdPath, `${first}.config`), 'utf8'),
    /Hostname 127\.0\.0\.1/,
  );
  await service.removeSSHKey(original, '127.0.0.1');
  await service.addSSHKey('fixture-private-key', renamed, '127.0.0.1');
  await assert.rejects(fs.stat(path.join(sshdPath, first)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(sshdPath, `${first}.config`)), {
    code: 'ENOENT',
  });
  assert.equal(
    (await fs.stat(path.join(sshdPath, getSubscriptionSshAlias(renamed))))
      .mode & 0o777,
    0o400,
  );
});
