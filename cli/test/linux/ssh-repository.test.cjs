const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createContext } = require('../../dist/local/context');
const { syncRepository } = require('../../dist/local/subscriptionRunner');

test(
  'real SSH subscriptions require the configured identity and pinned host key',
  { skip: process.env.QL_SSH_INTEGRATION !== '1', timeout: 30000 },
  async (t) => {
    assert.equal(process.platform, 'linux');
    assert.equal(
      process.getuid(),
      0,
      'Use only the disposable root SSH fixture container',
    );
    // sshd StrictModes rejects authorized_keys below world-writable /tmp.
    const root = await fs.mkdtemp('/var/lib/ql-ssh-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.chmod(root, 0o755);
    const run = (program, args) =>
      execFileSync(program, args, { stdio: 'pipe' }).toString();
    run('adduser', ['-D', '-H', '-s', '/bin/sh', 'qlfixture']);
    run('passwd', ['-d', 'qlfixture']);
    for (const name of ['host', 'identity', 'wrong'])
      run('ssh-keygen', [
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        path.join(root, name),
      ]);
    const authorized = path.join(root, 'authorized_keys');
    await fs.copyFile(path.join(root, 'identity.pub'), authorized);
    await fs.chmod(authorized, 0o644);
    const source = path.join(root, 'owner/repo');
    await fs.mkdir(source, { recursive: true });
    run('git', ['-C', source, 'init', '-b', 'selected']);
    run('git', ['-C', source, 'config', 'user.name', 'Fixture']);
    run('git', [
      '-C',
      source,
      'config',
      'user.email',
      'fixture@example.invalid',
    ]);
    await fs.writeFile(path.join(source, 'job.js'), 'selected SSH script');
    run('git', ['-C', source, 'add', '.']);
    run('git', ['-C', source, 'commit', '-m', 'fixture']);
    run('chown', ['-R', 'qlfixture:qlfixture', path.join(root, 'owner')]);
    const port = 22022;
    const serverConfig = path.join(root, 'sshd_config');
    await fs.writeFile(
      serverConfig,
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${authorized}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers qlfixture\nAllowTcpForwarding no\nX11Forwarding no\nUsePAM no\n`,
    );
    const server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostic = '';
    server.stderr.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-2000);
    });
    t.after(async () => {
      t.diagnostic(diagnostic);
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server.once('exit', resolve));
        server.kill('SIGTERM');
        await exited;
      }
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      if (ready || server.exitCode !== null) break;
      await delay(20);
    }
    assert.ok(ready, diagnostic);
    const knownHosts = path.join(root, 'known_hosts');
    const trusted = `[127.0.0.1]:${port} ${await fs.readFile(
      path.join(root, 'host.pub'),
      'utf8',
    )}`;
    const config = path.join(root, 'ssh_config');
    const configure = async (key = 'identity') =>
      fs.writeFile(
        config,
        `Host fixture\n HostName 127.0.0.1\n Port ${port}\n User qlfixture\n IdentityFile ${root}/${key}\n IdentityAgent none\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n ConnectTimeout 3\n`,
      );
    for (const url of [`ssh://fixture${source}`, `fixture:${source}`]) {
      await configure();
      await fs.writeFile(knownHosts, trusted);
      const panel = await fs.mkdtemp(path.join(root, 'panel-'));
      const env = {
        PATH: process.env.PATH,
        GIT_SSH_COMMAND: `ssh -F ${config}`,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_TERMINAL_PROMPT: '0',
      };
      const context = createContext({ root: panel }, env);
      const input = {
        url,
        branch: 'selected',
        autoAdd: false,
        autoDelete: false,
      };
      const result = await syncRepository(context, input);
      const job = path.join(
        context.paths.dir_scripts,
        result.repository,
        'job.js',
      );
      const checkout = path.join(context.paths.dir_repo, result.repository);
      const head = run('git', ['-C', checkout, 'rev-parse', 'HEAD']);
      assert.equal(await fs.readFile(job, 'utf8'), 'selected SSH script');
      for (const failure of ['identity', 'host-key']) {
        await configure(failure === 'identity' ? 'wrong' : 'identity');
        await fs.writeFile(
          knownHosts,
          failure === 'host-key'
            ? `[127.0.0.1]:${port} ${await fs.readFile(
                path.join(root, 'wrong.pub'),
                'utf8',
              )}`
            : trusted,
        );
        await assert.rejects(syncRepository(context, input));
        assert.equal(await fs.readFile(job, 'utf8'), 'selected SSH script');
        assert.equal(run('git', ['-C', checkout, 'rev-parse', 'HEAD']), head);
        assert.deepEqual(await fs.readdir(context.paths.dir_tmp), []);
      }
    }
  },
);
