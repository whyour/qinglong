'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONSOLE_ROOT = 'packages/ql3-cluster-admin/src/copilot-console';
const CLIENT_FILE = 'packages/ql3-cluster-admin/src/copilot-client/client.ts';
const ASSET_ROOT = 'packages/ql3-cluster-admin/assets/copilot-console';
const DEPLOYMENT_ROOT = 'deploy/console/ql3-cluster-copilot';
const REQUIRED_FILES = Object.freeze([
  CONSOLE_ROOT + '/assets.ts',
  CONSOLE_ROOT + '/cli.ts',
  CONSOLE_ROOT + '/contracts.ts',
  CONSOLE_ROOT + '/evidenceVerifier.ts',
  CONSOLE_ROOT + '/evidenceVerifierCli.ts',
  CONSOLE_ROOT + '/server.ts',
  'packages/ql3-cluster-admin/src/run-management/runCancellationInspection.ts',
  'packages/ql3-cluster-admin/src/plugin-package/management/pluginPackageInstallationProduct.ts',
  CLIENT_FILE,
  ASSET_ROOT + '/index.html',
  ASSET_ROOT + '/app.css',
  ASSET_ROOT + '/evidence-bundle.js',
  ASSET_ROOT + '/app.js',
  DEPLOYMENT_ROOT + '/README.md',
  DEPLOYMENT_ROOT + '/client-config.example.json',
  DEPLOYMENT_ROOT + '/run-management-client-config.example.json',
  DEPLOYMENT_ROOT + '/worker-management-client-config.example.json',
  DEPLOYMENT_ROOT + '/package-management-client-config.example.json',
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
    'CLUSTER_COPILOT_CONSOLE_READ_OPERATIONS',
    'CLUSTER_COPILOT_CONSOLE_READ_REQUEST_SCHEMA',
    'clusterCopilotConsoleClientCommand',
    'clusterCopilotConsoleProjectReadPath',
    "'run_event_list'",
    "'run_cancellation_status'",
    "'run_cancellation_blocked_list'",
    "'run_cancellation_inspect'",
    "'worker_list'",
    "'worker_inspect'",
    "'package_list'",
    "'package_inspect'",
    "'task_read'",
    "'workflow_step_list'",
  ]);
  rejectFragments(CONSOLE_ROOT + '/contracts.ts', [
    "| 'diagnose'",
    "'cancel'",
    'mutationId',
    'traceId',
    'endpoint',
    'credential',
  ]);
  expectFragments(CLIENT_FILE, [
    'executeClusterProjectApiRead',
    'PROJECT_READ_PATHS',
    "method: 'GET'",
    'readCredentialBytes(record.credentialFile as string)',
    'credentialBytes?.fill(0)',
  ]);
  rejectFragments(CLIENT_FILE, ["method: 'DELETE'", "method: 'PATCH'"]);
  expectFragments(CONSOLE_ROOT + '/server.ts', [
    "networkBoundary === 'host-loopback' ? '127.0.0.1' : '0.0.0.0'",
    "networkBoundary === 'container-published-loopback'",
    'server.listen(record.port as number, listenAddress',
    'request.headers.origin !== expectedOrigin',
    "request.headers.host !== expectedOrigin.slice('http://'.length)",
    'maximumConcurrentRequests: 2',
    "'/api/v1/copilot/inspect': 'inspect'",
    "'/api/v1/run-management/cancellation-status': 'run_cancellation_status'",
    "'/api/v1/worker-management/workers': 'worker_list'",
    "'/api/v1/package-management/installations': 'package_list'",
    "'/api/v1/observe/run-list': 'run_list'",
    "'/api/v1/observe/task-list': 'task_list'",
    "'/api/v1/observe/workflow-list': 'workflow_list'",
    "request.url === '/evidence-bundle.js'",
    'assets.evidenceBundle as string',
    "default-src 'none'",
    "frame-ancestors 'none'",
    "'cache-control': 'no-store'",
  ]);
  rejectFragments(CONSOLE_ROOT + '/server.ts', [
    'createSecureServer',
    'WebSocket',
    'set-cookie',
    'diagnose',
    'run.cancellation.rearm',
    'child_process',
    'node:fs',
    'node:net',
  ]);
  expectFragments(CONSOLE_ROOT + '/cli.ts', [
    '--session /absolute/session',
    '--run-management-config /absolute/run-client.json',
    '--run-management-assertion /absolute/assertion.jwt',
    '--worker-management-config /absolute/worker-client.json',
    '--worker-management-assertion /absolute/assertion.jwt',
    '--package-management-config /absolute/package-client.json',
    '--package-management-assertion /absolute/assertion.jwt',
    'readCanonicalFile(',
    "'private'",
    'validateClusterCopilotClientCredentialFile',
    "clusterCredential: 'server_only'",
    'networkBoundary: parsed.networkBoundary',
    "publishedHostAddress: '127.0.0.1'",
    'runManagementAuthority: runManagementAuthority',
    'workerManagementAuthority: workerManagementAuthority',
    'packageManagementAuthority: packageManagementAuthority',
    'mutation: false',
  ]);
  rejectFragments(CONSOLE_ROOT + '/cli.ts', [
    'process.env',
    '0.0.0.0',
    'diagnose',
    "operation: 'run.cancellation.rearm'",
  ]);
  expectFragments(CONSOLE_ROOT + '/evidenceVerifier.ts', [
    'qinglong/cluster-console-evidence-verification@v1',
    'maximumBundleBytes: 512 * 1024',
    'maximumRawBytes: 8 * 1024 * 1024',
    "rawFactDigests: 'not_recomputed_without_raw_facts'",
    "serverSignature: 'not_verified'",
    "attestation: 'not_verified'",
    "durableAudit: 'not_verified'",
    "actionAuthority: 'none'",
    'networkAccess: false',
    'mutation: false',
    'fileWrites: false',
    'constants.O_RDONLY',
    'constants.O_NOFOLLOW',
    "createHash('sha256')",
  ]);
  rejectFragments(CONSOLE_ROOT + '/evidenceVerifier.ts', [
    'node:http',
    'node:https',
    'node:net',
    'node:child_process',
    'writeFile',
    'appendFile',
    'createWriteStream',
    'process.env',
    'process.stdin',
    'fetch(',
  ]);
  expectFragments(CONSOLE_ROOT + '/evidenceVerifierCli.ts', [
    'ql3-copilot-evidence-verify --bundle=/absolute/evidence.json',
    'verifyClusterConsoleEvidenceBundleFile',
    'process.exitCode = 64',
    'process.exitCode = 65',
    'Cluster Console evidence bundle verification failed',
  ]);
  rejectFragments(CONSOLE_ROOT + '/evidenceVerifierCli.ts', [
    'process.env',
    'process.stdin',
    'node:http',
    'node:https',
    'writeFile',
  ]);
  expectFragments(ASSET_ROOT + '/index.html', [
    '沿着证据读，不替集群做决定。',
    '本机只读 BFF',
    '读取 Run 列表',
    '读取 Workflow Runs',
    '显式读取诊断内容',
    '读取取消可用性',
    '读取首屏 Blocked Runs',
    '读取首屏 Workers',
    '读取 Worker 详情',
    '读取首屏 Installations',
    '读取 Package 安装详情',
    '该只读面没有 rearm',
    '模型文本是不可信内容',
    '导出脱敏包',
    '/evidence-bundle.js',
  ]);
  expectFragments(ASSET_ROOT + '/app.js', [
    "credentials: 'omit'",
    "cache: 'no-store'",
    'output.textContent = JSON.stringify(fact, null, 2)',
    'nextPage(operation, request, fact)',
    'measureClusterConsoleEvidenceRecord(record)',
    'createClusterConsoleEvidenceBundle',
    'URL.revokeObjectURL(objectUrl)',
    "sessionToken = ''",
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
    'run.cancellation.rearm',
    'http://',
    'https://',
    'navigator.',
    'setTimeout(',
  ]);
  expectFragments(ASSET_ROOT + '/evidence-bundle.js', [
    'qinglong/cluster-console-redacted-evidence-bundle@v1',
    'maximumRecords: 16',
    'maximumRawBytes: 8 * 1024 * 1024',
    'maximumBundleBytes: 512 * 1024',
    "generatedBy: 'browser_local'",
    "actionAuthority: 'none'",
    "attestation: 'none'",
    "policy: 'fixed_allowlist_v1'",
    'freeTextIncluded: false',
    'copilotOutputIncluded: false',
    'createClusterConsoleEvidenceBundle',
    'verifyClusterConsoleEvidenceBundle',
  ]);
  rejectFragments(ASSET_ROOT + '/evidence-bundle.js', [
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'navigator.',
    'localStorage',
    'sessionStorage',
    'setTimeout(',
    'setInterval(',
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
    'Run, Task, Workflow',
    'thirteen exact operations',
    'available vocabulary to sixteen',
    'maximum vocabulary of twenty operations',
    'QL3_COPILOT_CONSOLE_RUN_MANAGEMENT=enabled',
    'QL3_COPILOT_CONSOLE_WORKER_MANAGEMENT=enabled',
    'QL3_COPILOT_CONSOLE_PACKAGE_MANAGEMENT=enabled',
    '--port=0',
    'TLS 1.3 `GET /readyz`',
    'excluded from small router Edge/Standalone artifacts',
    'Export a redacted evidence bundle',
    'Export performs zero BFF or Cluster',
    '8 MiB',
    '512 KiB',
    'server signature',
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
    "body.includes('Cluster field ledger')",
    'runConsoleContract(image);',
    'function runPublishedConsoleContract(image)',
    'runPublishedConsoleContract(image);',
    'consoleLoopback: true',
    'consoleAssets: true',
    'consoleEvidenceBundle: true',
    'evidenceVerifier: true',
    'function runEvidenceVerifierContract(image)',
    "[facade, 'evidence-verify', '--bundle=' + bundleFile]",
    "started.origin + '/evidence-bundle.js'",
    "consolePublishedHostAddress: '127.0.0.1'",
    'consoleDistributionEmbedded: true',
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
    manifest?.bin?.['ql3-copilot-console'] !== 'dist/copilot-console/cli.js' ||
    manifest?.bin?.['ql3-copilot-evidence-verify'] !==
      'dist/copilot-console/evidenceVerifierCli.js' ||
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
    !productCommand.includes("target: 'copilot-console/cli.js'") ||
    !productCommand.includes("name: 'evidence-verify'") ||
    !productCommand.includes("binary: 'ql3-copilot-evidence-verify'") ||
    !productCommand.includes("target: 'copilot-console/evidenceVerifierCli.js'")
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
    operations: Object.freeze([
      'inspect',
      'output',
      'run_cancellation_status',
      'run_cancellation_blocked_list',
      'run_cancellation_inspect',
      'worker_list',
      'worker_inspect',
      'package_list',
      'package_inspect',
      'run_list',
      'run_read',
      'run_event_list',
      'run_step_list',
      'task_list',
      'task_read',
      'workflow_list',
      'workflow_run_list',
      'workflow_run_read',
      'workflow_event_list',
      'workflow_step_list',
    ]),
    legacyUiCoupled: false,
    kubernetesResident: false,
    assetCount: 4,
    evidenceBundle: Object.freeze({
      lifecycle: 'browser-local-explicit-export',
      maximumRecords: 16,
      maximumRawBytes: 8 * 1024 * 1024,
      maximumBundleBytes: 512 * 1024,
      upstreamReadsOnExport: 0,
      attestation: 'none',
      actionAuthority: 'none',
    }),
    offlineVerifier: Object.freeze({
      lifecycle: 'operator-local-explicit-file-read',
      bundleDigest: 'recomputed',
      rawFactDigests: 'not_recomputed_without_raw_facts',
      serverSignature: 'not_verified',
      mutation: false,
      networkAccess: false,
      fileWrites: false,
    }),
    sourceFileCount: 7,
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
