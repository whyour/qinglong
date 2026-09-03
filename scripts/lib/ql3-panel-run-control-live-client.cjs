'use strict';

// Test tooling only: execute the shipped panel modules against a real loopback API.
// Neither TypeScript nor this VM adapter belongs in the product runtime artifact.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCES = Object.freeze({
  auth: 'src/utils/qinglong3.ts',
  control: 'src/components/qinglong3/runControl.ts',
});
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

function preparePanelClient(repository, directory) {
  const ts = require('typescript');
  fs.mkdirSync(directory, { mode: 0o700 });
  const manifest = {};
  for (const [name, relative] of Object.entries(SOURCES)) {
    const source = fs.readFileSync(path.join(repository, relative), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    fs.writeFileSync(path.join(directory, `${name}.cjs`), compiled, {
      flag: 'wx',
      mode: 0o600,
    });
    manifest[name] = {
      source: relative,
      sourceSha256: digest(source),
      compiledSha256: digest(compiled),
    };
  }
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify(manifest),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  return manifest;
}

function loadPanelClient(directory, port, transport = fetch) {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
  const origin = `http://127.0.0.1:${port}`;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
  );
  const requests = [];
  let loseCancellation = false;
  const context = vm.createContext({
    TextDecoder,
    Uint8Array,
    atob,
    crypto: crypto.webcrypto,
    fetch: async (relative, options) => {
      assert.ok(
        typeof relative === 'string' &&
          relative.startsWith('/') &&
          !relative.startsWith('//'),
      );
      const url = new URL(relative, origin);
      assert.equal(url.origin, origin);
      requests.push({
        path: relative,
        method: options.method,
        body: options.body,
      });
      const response = await transport(url.href, {
        ...options,
        signal: AbortSignal.timeout(10_000),
      });
      if (
        loseCancellation &&
        options.method === 'POST' &&
        relative.endsWith('/cancellation')
      ) {
        loseCancellation = false;
        // Consume a real committed response before simulating transport loss. Never fabricate a receipt.
        assert.equal(response.status, 202);
        const body = await response.json();
        assert.equal(body.status, 'accepted');
        throw new Error('Injected response loss after accepted cancellation');
      }
      return response;
    },
  });
  const load = (name, imports = {}) => {
    assert.equal(manifest[name].source, SOURCES[name]);
    assert.match(manifest[name].sourceSha256, /^[a-f0-9]{64}$/);
    const code = fs.readFileSync(path.join(directory, `${name}.cjs`), 'utf8');
    assert.equal(digest(code), manifest[name].compiledSha256);
    const mod = { exports: {} };
    vm.runInContext(`(function(require,exports,module){${code}\n})`, context)(
      (id) => {
        assert.ok(Object.hasOwn(imports, id), `Unexpected panel import ${id}`);
        return imports[id];
      },
      mod.exports,
      mod,
    );
    return mod.exports;
  };
  const auth = load('auth');
  const control = load('control', { '@/utils/qinglong3': auth });
  return {
    auth,
    control,
    requests,
    manifest,
    loseNextCancellationResponse() {
      loseCancellation = true;
    },
  };
}

module.exports = { preparePanelClient, loadPanelClient };
