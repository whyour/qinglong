const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LOCAL_MCP_SERVER_CONFIG_SCHEMA,
  normalizeLocalMcpServerConfig,
  readLocalMcpServerConfig,
} = require('@qinglong/local-mcp-server/config');

function candidate(root) {
  return {
    schema: LOCAL_MCP_SERVER_CONFIG_SCHEMA,
    profile: 'edge',
    projectId: 'default',
    deploymentRoot: root,
    databasePath: path.join(root, 'data', 'qinglong3.sqlite'),
    ownerPepperKeyringDirectory: path.join(root, 'owner-peppers'),
    credentialFilePath: path.join(root, 'operator', 'credential.json'),
    busyTimeoutMs: 500,
  };
}

test('accepts an exact private MCP config with deployment-root descendants', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-mcp-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const filePath = path.join(root, 'mcp.json');
  fs.writeFileSync(filePath, `${JSON.stringify(candidate(root))}\n`, {
    mode: 0o600,
  });

  assert.deepEqual(readLocalMcpServerConfig(filePath), candidate(root));
});

test('rejects public config files, extra keys and authority paths outside deployment root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-mcp-config-bad-'));
  try {
    fs.chmodSync(root, 0o700);
    const filePath = path.join(root, 'mcp.json');
    fs.writeFileSync(filePath, `${JSON.stringify(candidate(root))}\n`, {
      mode: 0o644,
    });
    assert.throws(() => readLocalMcpServerConfig(filePath), {
      code: 'LOCAL_MCP_SERVER_CONFIG_INVALID',
    });
    assert.throws(
      () => normalizeLocalMcpServerConfig({ ...candidate(root), extra: true }),
      { code: 'LOCAL_MCP_SERVER_CONFIG_INVALID' },
    );
    assert.throws(
      () =>
        normalizeLocalMcpServerConfig({
          ...candidate(root),
          credentialFilePath: path.join(os.tmpdir(), 'credential.json'),
        }),
      { code: 'LOCAL_MCP_SERVER_CONFIG_INVALID' },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
