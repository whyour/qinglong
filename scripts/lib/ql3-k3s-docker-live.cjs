#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_K3S_IMAGE = 'rancher/k3s:v1.34.3-k3s1';
const DEFAULT_K3S_DIGEST =
  'sha256:71abd3a56f57884c62732e0e0d87606052cb5f8555b7db7e8e33c04570b8175c';

function run(binary, args, options = {}) {
  if (!options.quiet) {
    process.stderr.write(`+ ${path.basename(binary)} ${args.join(' ')}\n`);
  }
  const result = spawnSync(binary, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : [
          options.input === undefined ? 'inherit' : 'pipe',
          'inherit',
          'inherit',
        ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${path.basename(binary)} failed with ${String(result.status)}: ` +
        `${result.stderr || result.stdout || ''}`,
    );
  }
  return Object.freeze({
    status: result.status,
    stdout: options.capture ? result.stdout.trim() : '',
    stderr: options.capture ? result.stderr.trim() : '',
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, inspect, intervalMs = 500) {
  const startedAt = Date.now();
  let last = 'not observed';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await inspect();
      if (value?.ready) {
        return Object.freeze({
          value: value.value,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (value?.fact) last = value.fact;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${description} timed out: ${last}`);
}

function safePrefix(value) {
  assert.match(value, /^ql3-[a-z0-9-]{1,32}$/);
  return value;
}

class K3sDockerLiveFixture {
  constructor(options = {}) {
    this.docker = options.docker ?? process.env.QL3_DOCKER_BIN ?? 'docker';
    this.kubectlBinary =
      options.kubectl ?? process.env.QL3_KUBECTL_BIN ?? 'kubectl';
    this.k3sImage = options.k3sImage ?? DEFAULT_K3S_IMAGE;
    this.k3sDigest = options.k3sDigest ?? DEFAULT_K3S_DIGEST;
    this.prefix = safePrefix(options.prefix ?? 'ql3-k3s-live');
    this.suffix = `${process.pid.toString(36)}-${randomBytes(3).toString(
      'hex',
    )}`;
    this.network = `${this.prefix}-network-${this.suffix}`;
    this.server = `${this.prefix}-server-${this.suffix}`;
    this.agents = [
      `${this.prefix}-agent-a-${this.suffix}`,
      `${this.prefix}-agent-b-${this.suffix}`,
    ];
    this.nodes = Object.freeze([this.server, ...this.agents]);
    this.temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), `${this.prefix}-${this.suffix}-`),
    );
    this.kubeconfig = path.join(this.temporary, 'kubeconfig');
    this.createdContainers = new Set();
    this.networkCreated = false;
    this.started = false;
  }

  dockerRun(args, options = {}) {
    return run(this.docker, args, options);
  }

  kubectl(args, options = {}) {
    assert.equal(this.started, true, 'K3s fixture is not started');
    return run(
      this.kubectlBinary,
      ['--kubeconfig', this.kubeconfig, ...args],
      options,
    );
  }

  kubectlJson(args) {
    return JSON.parse(
      this.kubectl([...args, '-o', 'json'], {
        capture: true,
        quiet: true,
      }).stdout,
    );
  }

  apply(manifest) {
    return this.kubectl(['apply', '-f', '-'], {
      input: `${JSON.stringify(manifest)}\n`,
      capture: true,
      quiet: true,
    });
  }

  create(manifest) {
    return this.kubectl(['create', '-f', '-'], {
      input: `${JSON.stringify(manifest)}\n`,
      capture: true,
      quiet: true,
    });
  }

  async start() {
    assert.equal(this.started, false, 'K3s fixture already started');
    this.dockerRun(['version'], { capture: true, quiet: true });
    const image = JSON.parse(
      this.dockerRun(['image', 'inspect', this.k3sImage], {
        capture: true,
        quiet: true,
      }).stdout,
    )[0];
    assert.ok(
      image.RepoDigests?.includes(`rancher/k3s@${this.k3sDigest}`),
      `K3s image does not retain reviewed digest ${this.k3sDigest}`,
    );
    for (const name of this.nodes) {
      assert.equal(
        this.dockerRun(['inspect', name], {
          capture: true,
          quiet: true,
          allowFailure: true,
        }).status,
        1,
        `refusing to reuse Docker container ${name}`,
      );
    }
    assert.equal(
      this.dockerRun(['network', 'inspect', this.network], {
        capture: true,
        quiet: true,
        allowFailure: true,
      }).status,
      1,
      `refusing to reuse Docker network ${this.network}`,
    );
    this.dockerRun(['network', 'create', this.network], {
      capture: true,
      quiet: true,
    });
    this.networkCreated = true;
    const token = randomBytes(32).toString('base64url');
    this.dockerRun(
      [
        'run',
        '-d',
        '--privileged',
        '--network',
        this.network,
        '--name',
        this.server,
        '-p',
        '127.0.0.1::6443',
        this.k3sImage,
        'server',
        '--token',
        token,
        '--node-name',
        this.server,
        '--disable=traefik',
        '--disable=servicelb',
        '--write-kubeconfig-mode=600',
        '--tls-san=127.0.0.1',
      ],
      { capture: true, quiet: true },
    );
    this.createdContainers.add(this.server);
    try {
      await waitFor('K3s control-plane readiness', 120_000, () => {
        const result = this.dockerRun(
          ['exec', this.server, 'kubectl', 'get', '--raw=/readyz'],
          { capture: true, quiet: true, allowFailure: true },
        );
        return result.status === 0 && result.stdout === 'ok'
          ? { ready: true, value: true }
          : { ready: false, fact: result.stderr || result.stdout };
      });
    } catch (error) {
      const state = this.dockerRun(
        ['inspect', '--format', '{{json .State}}', this.server],
        { capture: true, quiet: true, allowFailure: true },
      );
      const logs = this.dockerRun(['logs', '--tail', '120', this.server], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `state=${state.stdout || state.stderr}; ` +
          `logs=${logs.stderr || logs.stdout}`,
      );
    }
    for (const agent of this.agents) {
      this.dockerRun(
        [
          'run',
          '-d',
          '--privileged',
          '--network',
          this.network,
          '--name',
          agent,
          this.k3sImage,
          'agent',
          '--server',
          `https://${this.server}:6443`,
          '--token',
          token,
          '--node-name',
          agent,
        ],
        { capture: true, quiet: true },
      );
      this.createdContainers.add(agent);
    }
    const port = this.dockerRun(['port', this.server, '6443/tcp'], {
      capture: true,
      quiet: true,
    }).stdout;
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    const config = this.dockerRun(
      ['exec', this.server, 'cat', '/etc/rancher/k3s/k3s.yaml'],
      { capture: true, quiet: true },
    ).stdout.replace('https://127.0.0.1:6443', `https://${port}`);
    fs.writeFileSync(this.kubeconfig, `${config}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    this.started = true;
    let ready;
    try {
      ready = await waitFor('three ready K3s nodes', 300_000, () => {
        const nodes = this.kubectlJson(['get', 'nodes']).items ?? [];
        const readyNodes = nodes.filter((node) =>
          node.status.conditions?.some(
            (condition) =>
              condition.type === 'Ready' && condition.status === 'True',
          ),
        );
        return readyNodes.length === 3
          ? { ready: true, value: readyNodes }
          : { ready: false, fact: `${readyNodes.length}/3 Ready nodes` };
      });
    } catch (error) {
      const diagnostics = this.nodes.map((node) => {
        const state = this.dockerRun(
          ['inspect', '--format', '{{json .State}}', node],
          { capture: true, quiet: true, allowFailure: true },
        );
        const logs = this.dockerRun(['logs', '--tail', '80', node], {
          capture: true,
          quiet: true,
          allowFailure: true,
        });
        return {
          node,
          state: state.stdout || state.stderr,
          logs: logs.stderr || logs.stdout,
        };
      });
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `nodes=${JSON.stringify(diagnostics)}`,
      );
    }
    return ready.value;
  }

  inspectImage(reference) {
    const images = JSON.parse(
      this.dockerRun(['image', 'inspect', reference], {
        capture: true,
        quiet: true,
      }).stdout,
    );
    assert.equal(images.length, 1);
    return images[0];
  }

  loadImage(reference, archiveName = 'image.tar') {
    const archive = path.join(this.temporary, archiveName);
    this.dockerRun(['image', 'save', '--output', archive, reference]);
    try {
      for (const node of this.nodes) {
        const remote = `/tmp/${path.basename(archive)}`;
        this.dockerRun(['cp', archive, `${node}:${remote}`], {
          capture: true,
          quiet: true,
        });
        try {
          this.dockerRun(
            [
              'exec',
              node,
              'ctr',
              '--address',
              '/run/k3s/containerd/containerd.sock',
              '--namespace',
              'k8s.io',
              'images',
              'import',
              remote,
            ],
            { capture: true, quiet: true },
          );
        } finally {
          this.dockerRun(['exec', node, 'rm', '-f', remote], {
            capture: true,
            quiet: true,
            allowFailure: true,
          });
        }
      }
    } finally {
      fs.rmSync(archive, { force: true });
    }
  }

  containerAddress(name) {
    assert.ok(this.nodes.includes(name), `unknown fixture node ${name}`);
    const address = this.dockerRun(
      [
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        name,
      ],
      { capture: true, quiet: true },
    ).stdout;
    assert.match(address, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    return address;
  }

  stopNode(name) {
    assert.ok(this.nodes.includes(name), `unknown fixture node ${name}`);
    this.dockerRun(['stop', '--time', '1', name], {
      capture: true,
      quiet: true,
    });
  }

  startNode(name) {
    assert.ok(this.nodes.includes(name), `unknown fixture node ${name}`);
    this.dockerRun(['start', name], { capture: true, quiet: true });
  }

  async cleanup() {
    for (const name of [...this.createdContainers].reverse()) {
      this.dockerRun(['rm', '-f', '-v', name], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    this.createdContainers.clear();
    if (this.networkCreated) {
      this.dockerRun(['network', 'rm', this.network], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
      this.networkCreated = false;
    }
    fs.rmSync(this.temporary, { recursive: true, force: true });
    this.started = false;
  }
}

module.exports = {
  DEFAULT_K3S_DIGEST,
  DEFAULT_K3S_IMAGE,
  K3sDockerLiveFixture,
  run,
  sleep,
  waitFor,
};
