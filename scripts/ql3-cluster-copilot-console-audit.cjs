'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONSOLE_ROOT = 'packages/ql3-cluster-admin/src/copilot-console';
const ASSET_ROOT = 'packages/ql3-cluster-admin/assets/copilot-console';
const DEPLOYMENT_ROOT = 'deploy/console/ql3-cluster-copilot';
const REQUIRED_FILES = Object.freeze([
  CONSOLE_ROOT + '/assets.ts',
  CONSOLE_ROOT + '/cli.ts',
  CONSOLE_ROOT + '/contracts.ts',
  CONSOLE_ROOT + '/server.ts',
  ASSET_ROOT + '/index.html',
  ASSET_ROOT + '/app.css',
  ASSET_ROOT + '/app.js',
  DEPLOYMENT_ROOT + '/README.md',
  DEPLOYMENT_ROOT + '/client-config.example.json',
  'deploy/containers/ql3-cluster-admin/Dockerfile',
  'scripts/ql3-cluster-admin-product-live-contract.cjs',
]);

function finding(code, target, detail) {
  return Object.freeze({ code, target, detail });
}

function filesBelow(root, relativeDirectory) {
  const absolute = path.join(root, relativeDirectory);
  const result = [];
  const pending = [absolute];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) result.push(path.relative(root, candidate));
    }
  }
  return result.sort();
}

function auditClusterCopilotConsole(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const readFile =
    options.readFile ||
    ((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'));
  const findings = [];
  const source = {};

  for (const relativePath of REQUIRED_FILES) {
    try {
      source[relativePath] = readFile(relativePath);
    } catch (error) {
      findings.push(
        finding(
          'CLUSTER_COPILOT_CONSOLE_FILE_MISSING',
          relativePath,
          error instanceof Error ? error.name : 'Error',
        ),
      );
    }
  }

  const expectFragments = (relativePath, fragments) => {
    const contents = source[relativePath];
    if (typeof contents !== 'string') return;
    for (const fragment of fragments) {
      if (!contents.includes(fragment)) {
        findings.push(
          finding(
            'CLUSTER_COPILOT_CONSOLE_CONTRACT_MISSING',
            relativePath,
            fragment,
          ),
        );
      }
    }
  };
  const rejectFragments = (relativePath, fragments) => {
    const contents = source[relativePath];
    if (typeof contents !== 'string') return;
    for (const fragment of fragments) {
      if (contents.includes(fragment)) {
        findings.push(
          finding(
            'CLUSTER_COPILOT_CONSOLE_AUTHORITY_WIDENED',
            relativePath,
            fragment,
          ),
        );
      }
    }
  };

  expectFragments(CONSOLE_ROOT + '/contracts.ts', [
    "export type ClusterCopilotConsoleReadOperation = 'inspect' | 'output'",
    'CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA',
    'clusterCopilotConsoleClientCommand',
  ]);
  rejectFragments(CONSOLE_ROOT + '/contracts.ts', [
    "| 'diagnose'",
    "| 'cancel'",
    'mutationId',
    'traceId',
    'endpoint',
    'credential',
  ]);
  expectFragments(CONSOLE_ROOT + '/server.ts', [
    "server.listen(record.port as number, '127.0.0.1'",
    'request.headers.origin !== expectedOrigin',
    "request.headers.host !== expectedOrigin.slice('http://'.length)",
    'maximumConcurrentRequests: 2',
    "request.url === '/api/v1/copilot/inspect'",
    "request.url === '/api/v1/copilot/output'",
    "default-src 'none'",
    "frame-ancestors 'none'",
    "'cache-control': 'no-store'",
  ]);
  rejectFragments(CONSOLE_ROOT + '/server.ts', [
    "'0.0.0.0'",
    'createSecureServer',
    'WebSocket',
    'set-cookie',
    'diagnose',
    'cancel',
    'child_process',
    'node:fs',
    'node:net',
  ]);
  expectFragments(CONSOLE_ROOT + '/cli.ts', [
    '--session /absolute/session',
    'readCanonicalFile(',
    "'private'",
    'validateClusterCopilotClientCredentialFile',
    "clusterCredential: 'server_only'",
    "operations: ['inspect', 'output']",
    'mutation: false',
  ]);
  rejectFragments(CONSOLE_ROOT + '/cli.ts', [
    'process.env',
    '0.0.0.0',
    'diagnose',
    'cancel',
  ]);
  expectFragments(ASSET_ROOT + '/index.html', [
    '故障诊断，不替你执行。',
    '只读边界',
    '显式读取诊断内容',
    '不可信模型输出',
  ]);
  expectFragments(ASSET_ROOT + '/app.js', [
    'credentials: "omit"',
    'cache: "no-store"',
    'outputText.textContent = fact.result.text',
    'sessionToken = ""',
  ]);
  rejectFragments(ASSET_ROOT + '/app.js', [
    'localStorage',
    'sessionStorage',
    'innerHTML',
    'eval(',
    'new Function',
    'WebSocket',
    'EventSource',
    'diagnose',
    'cancel',
    'http://',
    'https://',
  ]);
  expectFragments(ASSET_ROOT + '/app.css', [
    '@media (max-width: 520px)',
    '@media (prefers-reduced-motion: reduce)',
    ':focus-visible',
  ]);
  expectFragments(DEPLOYMENT_ROOT + '/README.md', [
    'operator-workstation process',
    'Do not deploy it as a Kubernetes workload',
    'only `inspect` and explicit `output` reads',
    '--port=0',
    'TLS 1.3 `GET /readyz`',
    'excluded from small router Edge/Standalone artifacts',
  ]);
  rejectFragments(DEPLOYMENT_ROOT + '/README.md', [
    '--host=0.0.0.0',
    'kubectl apply',
    'localStorage',
  ]);
  expectFragments('deploy/containers/ql3-cluster-admin/Dockerfile', [
    'COPY --from=workspace /workspace/packages/ql3-cluster-admin/assets/copilot-console',
    'node_modules/@qinglong/cluster-admin/assets/copilot-console',
  ]);
  expectFragments('scripts/ql3-cluster-admin-product-live-contract.cjs', [
    'function runConsoleContract(image)',
    "[facade, 'copilot-console'",
    "started.event !== 'started'",
    "body.includes('Cluster field console')",
    'runConsoleContract(image);',
    'consoleLoopback: true',
    'consoleAssets: true',
  ]);

  let manifest;
  try {
    manifest = JSON.parse(readFile('packages/ql3-cluster-admin/package.json'));
  } catch (error) {
    findings.push(
      finding(
        'CLUSTER_COPILOT_CONSOLE_PACKAGE_INVALID',
        'packages/ql3-cluster-admin/package.json',
        error instanceof Error ? error.name : 'Error',
      ),
    );
  }
  if (
    manifest?.bin?.['ql3-copilot-console'] !==
      'dist/copilot-console/cli.js' ||
    manifest?.exports?.['./copilot-console']?.require !==
      './dist/copilot-console/server.js' ||
    !Array.isArray(manifest?.files) ||
    !manifest.files.includes('assets/copilot-console/*')
  ) {
    findings.push(
      finding(
        'CLUSTER_COPILOT_CONSOLE_PACKAGE_INVALID',
        'packages/ql3-cluster-admin/package.json',
        'bin, export or asset packlist drifted',
      ),
    );
  }

  let productCommand = '';
  try {
    productCommand = readFile(
      'packages/ql3-cluster-admin/src/product-cli/productCommand.ts',
    );
  } catch {}
  if (
    !productCommand.includes("name: 'copilot-console'") ||
    !productCommand.includes("binary: 'ql3-copilot-console'") ||
    !productCommand.includes("target: 'copilot-console/cli.js'")
  ) {
    findings.push(
      finding(
        'CLUSTER_COPILOT_CONSOLE_PRODUCT_ENTRY_MISSING',
        'packages/ql3-cluster-admin/src/product-cli/productCommand.ts',
        'static product delegation is incomplete',
      ),
    );
  }

  for (const relativePath of filesBelow(root, 'src')) {
    const contents = readFile(relativePath);
    if (
      contents.includes('ql3-copilot-console') ||
      contents.includes('cluster-copilot-console-read') ||
      contents.includes('copilot/failure-diagnoses')
    ) {
      findings.push(
        finding(
          'CLUSTER_COPILOT_CONSOLE_LEGACY_UI_COUPLED',
          relativePath,
          'legacy src imports or routes the QingLong 3.0 Console',
        ),
      );
    }
  }
  for (const relativePath of filesBelow(root, 'back')) {
    const contents = readFile(relativePath);
    if (
      contents.includes('ql3-copilot-console') ||
      contents.includes('cluster-copilot-console-read')
    ) {
      findings.push(
        finding(
          'CLUSTER_COPILOT_CONSOLE_LEGACY_BACKEND_COUPLED',
          relativePath,
          'legacy backend owns the QingLong 3.0 Console',
        ),
      );
    }
  }
  for (const relativePath of filesBelow(root, 'deploy/kubernetes')) {
    if (!/\.ya?ml$/u.test(relativePath)) continue;
    const contents = readFile(relativePath);
    if (contents.includes('ql3-copilot-console')) {
      findings.push(
        finding(
          'CLUSTER_COPILOT_CONSOLE_KUBERNETES_RESIDENT',
          relativePath,
          'operator-workstation Console must not be a Kubernetes workload',
        ),
      );
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    component: 'cluster-copilot-console',
    owner: '@qinglong/cluster-admin',
    lifecycle: 'operator-workstation-loopback',
    operations: Object.freeze(['inspect', 'output']),
    legacyUiCoupled: false,
    kubernetesResident: false,
    assetCount: 3,
    sourceFileCount: 4,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function main() {
  const report = auditClusterCopilotConsole();
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.compatible) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { auditClusterCopilotConsole };
