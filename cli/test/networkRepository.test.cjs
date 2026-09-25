const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createContext } = require('../dist/local/context');
const { syncRepository } = require('../dist/local/subscriptionRunner');
const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';

for (const tls of [false, true])
  test(
    `authenticated Git ${
      tls ? 'HTTPS/CONNECT' : 'HTTP/proxy'
    } transport preserves checkout after access failure`,
    { timeout: 30000 },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-git-http-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const execPath = execFileSync(git, ['--exec-path'], {
        encoding: 'utf8',
      }).trim();
      await fs.access(path.join(execPath, 'git-http-backend')).catch(() => {
        throw new Error(
          'Test prerequisite missing: git-http-backend (Alpine: git-daemon).',
        );
      });
      const source = path.join(root, 'owner/repo.git');
      await fs.mkdir(source, { recursive: true });
      const run = (...args) =>
        execFileSync(git, ['-C', source, ...args], { stdio: 'pipe' });
      run('init', '-b', 'main');
      run('config', 'user.name', 'Fixture');
      run('config', 'user.email', 'fixture@example.invalid');
      await fs.writeFile(path.join(source, 'wrong.js'), 'wrong branch');
      run('add', '.');
      run('commit', '-m', 'main');
      run('checkout', '-b', 'selected');
      await fs.rm(path.join(source, 'wrong.js'));
      await fs.writeFile(path.join(source, 'job.js'), 'version one');
      await fs.writeFile(path.join(source, 'helper.js'), 'dependency');
      run('add', '-A');
      run('commit', '-m', 'selected');
      const authorization = `Basic ${Buffer.from(
        `fixture:${randomUUID()}`,
      ).toString('base64')}`;
      let failure = false;
      const requests = [];
      const children = new Set();
      let certificate;
      let tlsOptions;
      if (tls) {
        certificate = path.join(root, 'certificate.pem');
        const key = path.join(root, 'key.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            certificate,
            '-subj',
            '/CN=127.0.0.1',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
            '-days',
            '1',
          ],
          { stdio: 'pipe' },
        );
        tlsOptions = {
          key: await fs.readFile(key),
          cert: await fs.readFile(certificate),
        };
      }
      const serveGit = (req, res) => {
        const url = new URL(req.url, 'http://fixture.invalid');
        requests.push({
          method: req.method,
          path: url.pathname,
          proxy: req.url.startsWith('http://'),
        });
        if (failure) {
          res.writeHead(503).end();
          req.resume();
          return;
        }
        if (req.headers.authorization !== authorization) {
          res
            .writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
            .end();
          req.resume();
          return;
        }
        const child = spawn(git, ['http-backend'], {
          env: {
            PATH: process.env.PATH,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: req.method,
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers['content-type'] || '',
            CONTENT_LENGTH: req.headers['content-length'] || '',
            REMOTE_USER: 'fixture',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        child.on('error', () => res.destroy());
        child.on('close', () => children.delete(child));
        child.stderr.resume();
        child.stdin.on('error', () => {});
        req.pipe(child.stdin);
        let pending = Buffer.alloc(0),
          headersSent = false;
        child.stdout.on('data', (chunk) => {
          if (headersSent) {
            res.write(chunk);
            return;
          }
          pending = Buffer.concat([pending, chunk]);
          const boundary = pending.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          let status = 200;
          const headers = {};
          for (const line of pending
            .subarray(0, boundary)
            .toString()
            .split('\r\n')) {
            const colon = line.indexOf(':');
            const key = line.slice(0, colon),
              value = line.slice(colon + 1).trim();
            if (key.toLowerCase() === 'status')
              status = Number(value.split(' ')[0]);
            else headers[key] = value;
          }
          res.writeHead(status, headers);
          headersSent = true;
          res.write(pending.subarray(boundary + 4));
        });
        child.stdout.on('end', () => res.end());
      };
      const server = tls
        ? https.createServer(tlsOptions, serveGit)
        : http.createServer(serveGit);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        for (const child of children) child.kill('SIGKILL');
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const endpoint = `${tls ? 'https' : 'http'}://127.0.0.1:${
        server.address().port
      }`;
      let proxyEndpoint = endpoint;
      let tunnels = 0;
      if (tls) {
        const sockets = new Set();
        const tunnel = http.createServer((req, res) =>
          res.writeHead(405).end(),
        );
        tunnel.on('connect', (req, client, head) => {
          if (req.url !== `127.0.0.1:${server.address().port}`) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
          }
          tunnels++;
          const upstream = net.connect(
            server.address().port,
            '127.0.0.1',
            () => {
              client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              if (head.length) upstream.write(head);
              client.pipe(upstream);
              upstream.pipe(client);
            },
          );
          for (const socket of [client, upstream]) {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
          }
          client.on('error', () => upstream.destroy());
          upstream.on('error', () => client.destroy());
          client.on('close', () => upstream.destroy());
          upstream.on('close', () => client.destroy());
        });
        await new Promise((resolve) => tunnel.listen(0, '127.0.0.1', resolve));
        proxyEndpoint = `http://127.0.0.1:${tunnel.address().port}`;
        t.after(async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve) => tunnel.close(resolve));
        });
      }
      for (const [proxy, credentialMode] of [
        [false, 'header'],
        [true, 'header'],
        [false, 'helper'],
        [true, 'helper'],
      ]) {
        failure = false;
        const panel = path.join(
          root,
          `${credentialMode}-${proxy ? 'proxied-panel' : 'direct-panel'}`,
        );
        await fs.mkdir(panel);
        const env = {
          PATH: `/usr/bin:/bin:${process.env.PATH}`,
          GIT_TERMINAL_PROMPT: '0',
          ...(tls ? { GIT_SSL_CAINFO: certificate } : {}),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
          http_proxy: '',
          https_proxy: '',
          all_proxy: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          NO_PROXY: '',
          no_proxy: '',
        };
        if (credentialMode === 'helper') {
          const credentialFile = path.join(panel, 'credentials');
          const credential = new URL(
            proxy && !tls ? 'http://repository.invalid' : endpoint,
          );
          const [username, password] = Buffer.from(
            authorization.slice(6),
            'base64',
          )
            .toString()
            .split(':');
          credential.username = username;
          credential.password = password;
          await fs.writeFile(credentialFile, credential.toString() + '\n', {
            mode: 0o600,
          });
          env.GIT_CONFIG_KEY_0 = 'credential.helper';
          env.GIT_CONFIG_VALUE_0 =
            "store --file='" + credentialFile.replaceAll("'", "'\"'\"'") + "'";
        }
        const context = createContext({ root: panel }, env);
        const input = {
          url: `${
            proxy && !tls ? 'http://repository.invalid' : endpoint
          }/owner/repo.git`,
          branch: 'selected',
          include: '^job',
          dependencies: '^helper',
          autoAdd: false,
          autoDelete: false,
          ...(proxy ? { proxy: proxyEndpoint } : {}),
        };
        const start = requests.length;
        const previousTunnels = tunnels;
        const result = await syncRepository(context, input);
        const destination = path.join(
          context.paths.dir_scripts,
          result.repository,
        );
        assert.equal(
          await fs.readFile(path.join(destination, 'job.js'), 'utf8'),
          'version one',
        );
        assert.equal(
          await fs.readFile(path.join(destination, 'helper.js'), 'utf8'),
          'dependency',
        );
        await assert.rejects(fs.access(path.join(destination, 'wrong.js')));
        assert.ok(
          requests
            .slice(start)
            .some(
              (row) =>
                row.method === 'POST' &&
                row.path.endsWith('/git-upload-pack') &&
                row.proxy === (proxy && !tls),
            ),
        );
        if (tls && proxy)
          assert.ok(
            tunnels > previousTunnels,
            'HTTPS must traverse the CONNECT proxy',
          );
        const checkout = path.join(context.paths.dir_repo, result.repository);
        const head = execFileSync(git, [
          '-C',
          checkout,
          'rev-parse',
          'HEAD',
        ]).toString();
        for (const kind of [
          'unauthorized',
          'unavailable',
          ...(tls ? ['untrusted'] : []),
        ]) {
          failure = kind === 'unavailable';
          const failedContext =
            kind === 'unauthorized'
              ? createContext(
                  { root: panel },
                  { ...env, GIT_CONFIG_COUNT: '0' },
                )
              : kind === 'untrusted'
              ? createContext(
                  { root: panel },
                  { ...env, GIT_SSL_CAINFO: undefined },
                )
              : context;
          await assert.rejects(syncRepository(failedContext, input));
          assert.equal(
            await fs.readFile(path.join(destination, 'job.js'), 'utf8'),
            'version one',
          );
          assert.equal(
            execFileSync(git, ['-C', checkout, 'rev-parse', 'HEAD']).toString(),
            head,
          );
          assert.deepEqual(await fs.readdir(context.paths.dir_tmp), []);
        }
      }
    },
  );
