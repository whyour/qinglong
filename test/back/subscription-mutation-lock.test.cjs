const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-subscription-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { scriptPath: path.join(root, 'scripts/') };
  const { withSubscriptionMutation } = load(
    'back/shared/subscriptionMutationLock.ts',
    { '../config': config },
  );
  return { root, config, withSubscriptionMutation };
}

test('subscription ownership mutations exclude a second process until cleanup completes', async (t) => {
  const f = fixture(t);
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve));
  const held = new Promise((resolve) => (entered = resolve));
  t.after(() => release());
  const first = f.withSubscriptionMutation(async () => {
    entered();
    await gate;
  });
  await held;
  const marker = path.join(f.root, 'second-writer');
  const source = `
    const load = require(${JSON.stringify(
      path.resolve('test/helpers/load-security-module.cjs'),
    )});
    const { withSubscriptionMutation } = load(${JSON.stringify(
      path.resolve('back/shared/subscriptionMutationLock.ts'),
    )}, { '../config': ${JSON.stringify(f.config)} });
    process.send('attempt');
    withSubscriptionMutation(async () => require('fs').writeFileSync(${JSON.stringify(
      marker,
    )}, 'done'))
      .then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => child.kill());
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(errors || `child exit ${code}`)),
    );
  });
  await new Promise((resolve) => child.once('message', resolve));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fs.existsSync(marker), false);
  release();
  await Promise.all([first, completed]);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
  assert.equal(
    fs.existsSync(`${path.resolve(f.config.scriptPath)}.subscriptions.lock`),
    false,
  );
});

test('failed subscription mutations release the lock before the next operation', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.withSubscriptionMutation(async () => {
      throw new Error('failed cleanup');
    }),
    /failed cleanup/,
  );
  assert.equal(
    await f.withSubscriptionMutation(async () => 'next mutation'),
    'next mutation',
  );
});
