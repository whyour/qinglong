#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const {
  applySecret,
  currentPrimaryPod,
  imageIdDigest,
  localManifest,
  psql,
} = require('./lib/ql3-management-kubernetes-live-platform.cjs');
const {
  podReady,
} = require('./lib/ql3-management-kubernetes-live.cjs');
const {
  createManagementIdentityCeremony,
} = require('./lib/ql3-management-live-identity.cjs');
const {
  imageDigest,
  imageTag,
  reviewedOperatorManifest,
} = require('./ql3-cloudnativepg-live-contract.cjs');
const {
  FIXTURE,
  LIMITATIONS,
  validateSecurityAdministrationKubernetesLiveReport,
} = require('./ql3-security-administration-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const NAME = 'ql3-security-administration';
const POSTGRES_CLUSTER = 'ql3-postgres';
const DELIVERY_CLAIM = 'ql3-security-administration-delivery';
const CONTROL_NAME = 'ql3-security-live-control';
const CONTROL_RUNTIME_SECRET = 'ql3-security-live-control-runtime';
const ADMIN_IMAGE_BASE = 'ql3-security-administration-live';
const CONTROL_IMAGE_BASE = 'ql3-security-administration-migration-live';
const ISSUER = 'https://identity.qinglong.test/';
const ROLE_NAMES = Object.freeze([
  'ql3_migration',
  'ql3_ai_maintenance',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
  'ql3_runtime',
  'ql3_admin',
  'ql3_package_manager',
  'ql3_package_executor',
  'ql3_automation_manager',
  'ql3_approval_manager',
  'ql3_run_manager',
  'ql3_worker_credential_manager',
  'ql3_worker_credential_executor',
  'ql3_worker_ingress',
]);
const LOCK = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/operator-lock.json',
    ),
    'utf8',
  ),
);
const OPERATOR_IMAGE = LOCK.operator.image;
const POSTGRES_IMAGE = LOCK.operand.image;
const identity = createManagementIdentityCeremony({
  issuer: ISSUER,
  audience: 'qinglong3-security-administration',
  purpose: 'security-administration',
  tokenType: 'ql3-security-administration+jwt',
  subject: 'security-owner',
  jtiPrefix: 'ql3-security-administration-live',
});

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function apiCredentialPepperKeyring(activePepperKeyId, keys) {
  assert.ok(keys.length === 1 || keys.length === 2);
  assert.ok(keys.some((key) => key.pepperKeyId === activePepperKeyId));
  return Object.freeze({
    schemaVersion: 1,
    activePepperKeyId,
    keys: Object.freeze(
      keys.map((key) =>
        Object.freeze({
          pepperKeyId: key.pepperKeyId,
          pepper: key.pepper,
        }),
      ),
    ),
  });
}

function sqlString(value) {
  assert.equal(typeof value, 'string');
  return `'${value.replaceAll("'", "''")}'`;
}

function identityRegisterCommand(values) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'identity.register',
    request: Object.freeze({
      mutationId: values.identityMutationId,
      requestId: values.registerRequestId,
      expectedCurrentVersion: 0,
      subject: values.subject,
    }),
  });
}

function auditListCommand() {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'audit.list',
    request: Object.freeze({
      limit: 25,
      filter: Object.freeze({ outcome: 'allowed' }),
    }),
  });
}

function pepperReferencesCommand(pepperKeyId) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'pepper.references',
    request: Object.freeze({ pepperKeyId, limit: 64 }),
  });
}

function credentialIssueCommand(values) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'credential.issue',
    request: Object.freeze({
      mutationId: values.issueMutationId,
      requestId: values.issueRequestId,
      expectedCurrentVersion: 0,
      credentialId: values.credentialId,
      subject: values.subject,
      notBeforeAtMs: values.notBeforeAtMs,
      expiresAtMs: values.expiresAtMs,
    }),
  });
}

function credentialRotateCommand(values) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'credential.rotate',
    request: Object.freeze({
      mutationId: values.rotateMutationId,
      requestId: values.rotateRequestId,
      expectedCurrentVersion: 1,
      credentialId: values.credentialId,
      subject: values.subject,
      notBeforeAtMs: values.notBeforeAtMs,
      expiresAtMs: values.expiresAtMs,
    }),
  });
}

function credentialRevokeCommand(values) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'credential.revoke',
    request: Object.freeze({
      mutationId: values.revokeMutationId,
      requestId: values.revokeRequestId,
      expectedCurrentVersion: values.expectedCurrentVersion ?? 2,
      credentialId: values.credentialId,
      subject: values.subject,
    }),
  });
}

function privateReportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-security-administration-kubernetes-live-contract --report=/absolute/private-report.json',
    );
  }
  const reportFile = argv[0].slice('--report='.length);
  if (fs.existsSync(reportFile)) {
    throw new Error('refusing to overwrite the Security Administration report');
  }
  const parent = fs.lstatSync(path.dirname(reportFile));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Security Administration report parent must be real');
  }
  return reportFile;
}

function localAdministrationManifest(rendered, localImage) {
  const placeholder =
    'registry.example.com/qinglong/qinglong3-cluster-admin@sha256:' +
    '0'.repeat(64);
  assert.equal(rendered.split(placeholder).length - 1, 2);
  return rendered
    .replaceAll(placeholder, localImage)
    .replaceAll('imagePullPolicy: IfNotPresent', 'imagePullPolicy: Never');
}

function renderedResources(fixture, directory, localImage) {
  const rendered = localAdministrationManifest(
    fixture.kubectl(['kustomize', directory], {
      capture: true,
      quiet: true,
    }).stdout,
    localImage,
  );
  const resources = [];
  yaml.loadAll(rendered, (resource) => {
    if (resource) resources.push(resource);
  });
  return resources;
}

function namedResource(resources, kind, name) {
  const selected = resources.find(
    (resource) => resource.kind === kind && resource.metadata?.name === name,
  );
  assert.ok(selected, `${kind}/${name} is absent`);
  return selected;
}

function findNamed(values, name) {
  const selected = values.find((value) => value.name === name);
  assert.ok(selected, `${name} is absent`);
  return selected;
}

function inputAuthorityEvidenceSource() {
  return `'use strict';const fs=require('node:fs');const path=require('node:path');const names=['command.json','assertion.jwt','keyset.json','pepper-keyring.json'];const source='/var/run/secrets/qinglong3/security-administration-projected';const parent='/var/run/qinglong3/security-administration-private';const target=parent+'/input';const deliveryRoot='/var/lib/qinglong3/security-administration-delivery';const deliveryPrivate=deliveryRoot+'/private';const facts=(value)=>{const status=fs.lstatSync(value);return{mode:(status.mode&0o7777).toString(8),uid:status.uid,gid:status.gid,directory:status.isDirectory(),file:status.isFile(),symlink:status.isSymbolicLink()}};const sourceReal=fs.realpathSync(source);const files=names.map((name)=>{const candidate=source+'/'+name;const resolved=fs.realpathSync(candidate);const relative=path.relative(sourceReal,resolved);return{name,link:facts(candidate),resolved:facts(resolved),confined:relative!==''&&relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative)}});fs.writeFileSync('/dev/termination-log',JSON.stringify({schema:'qinglong/security-administration-input-authority@v1',source:facts(source),parent:facts(parent),targetExists:fs.existsSync(target),deliveryRoot:fs.existsSync(deliveryRoot)?facts(deliveryRoot):null,deliveryPrivateExists:fs.existsSync(deliveryPrivate),files}));`;
}

function deliveryVolumeProvisionSource() {
  return `'use strict';const fs=require('node:fs');const root='/delivery';const facts=()=>{const status=fs.lstatSync(root);return{mode:(status.mode&0o7777).toString(8),uid:status.uid,gid:status.gid,directory:status.isDirectory(),symlink:status.isSymbolicLink()}};const before=facts();if(!before.directory||before.symlink||before.uid!==0||before.gid!==10001||before.mode!=='2777')throw new Error('UNEXPECTED_VOLUME_ROOT');fs.chmodSync(root,0o2770);const descriptor=fs.openSync(root,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY??0));try{fs.fsyncSync(descriptor)}finally{fs.closeSync(descriptor)}const after=facts();if(!after.directory||after.symlink||after.uid!==0||after.gid!==10001||after.mode!=='2770')throw new Error('VOLUME_ROOT_NOT_CONSTRAINED');fs.writeFileSync('/dev/termination-log',JSON.stringify({schema:'qinglong/security-administration-delivery-volume-provision@v1',beforeMode:before.mode,afterMode:after.mode,uid:after.uid,gid:after.gid,passed:true}));`;
}

function networkPolicyReadinessSource() {
  return String.raw`
const fs=require('node:fs');const net=require('node:net');
const connect=(host,port)=>new Promise((resolve)=>{let settled=false;const socket=net.createConnection({host,port});const done=(ok)=>{if(settled)return;settled=true;socket.destroy();resolve(ok)};socket.setTimeout(500);socket.once('connect',()=>done(true));socket.once('timeout',()=>done(false));socket.once('error',()=>done(false));});
const sleep=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
(async()=>{let consecutive=0;let networkEvidence={databaseConnected:false,kubernetesApiConnected:false,publicInternetConnected:false};for(let attempt=1;attempt<=120;attempt+=1){const kubernetesApiConnected=await connect(process.argv[2],443);const publicInternetConnected=await connect('1.1.1.1',443);const databaseConnected=await connect(process.argv[1],5432);networkEvidence={databaseConnected,kubernetesApiConnected,publicInternetConnected};consecutive=databaseConnected&&!kubernetesApiConnected&&!publicInternetConnected?consecutive+1:0;if(consecutive>=2){fs.writeFileSync('/dev/termination-log',JSON.stringify({schemaVersion:1,passed:true,attempt,consecutive,...networkEvidence}));return}await sleep(250)}fs.writeFileSync('/dev/termination-log',JSON.stringify({schemaVersion:1,passed:false,code:'NETWORK_POLICY_NOT_ENFORCED',...networkEvidence}));process.exitCode=1})().catch(()=>{fs.writeFileSync('/dev/termination-log',JSON.stringify({schemaVersion:1,passed:false,code:'NETWORK_POLICY_READINESS_UNAVAILABLE'}));process.exitCode=1});`;
}

function networkPolicyReadinessContainer(adminImage, kubernetesServiceIp) {
  return {
    name: 'wait-network-policy',
    image: adminImage,
    imagePullPolicy: 'Never',
    command: [
      'node',
      '-e',
      networkPolicyReadinessSource(),
      'ql3-postgres-rw.qinglong3-system.svc',
      kubernetesServiceIp,
    ],
    terminationMessagePolicy: 'File',
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
    resources: {
      requests: { cpu: '5m', memory: '16Mi' },
      limits: { cpu: '100m', memory: '64Mi' },
    },
  };
}

function administrationJob(
  template,
  {
    name,
    inputSecretName,
    deliveryFile,
    projectedMode,
    kubernetesServiceIp,
  },
) {
  const job = structuredClone(template);
  job.metadata.name = name;
  delete job.metadata.uid;
  delete job.metadata.resourceVersion;
  job.spec.template.metadata.labels['ql3.live/job'] = name;
  const projected = findNamed(job.spec.template.spec.volumes, 'projected-input');
  projected.secret.secretName = inputSecretName;
  projected.secret.defaultMode = projectedMode ?? 0o440;
  const stager = findNamed(
    job.spec.template.spec.initContainers,
    'stage-private-input',
  );
  stager.terminationMessagePolicy = 'FallbackToLogsOnError';
  const inspector = structuredClone(stager);
  inspector.name = 'inspect-input-authority';
  inspector.command = ['node', '-e', inputAuthorityEvidenceSource()];
  inspector.args = [];
  inspector.terminationMessagePolicy = 'File';
  inspector.volumeMounts = inspector.volumeMounts.filter((mount) =>
    ['projected-input', 'private-input', 'credential-delivery'].includes(
      mount.name,
    ),
  );
  job.spec.template.spec.initContainers.unshift(inspector);
  job.spec.template.spec.initContainers.unshift(
    networkPolicyReadinessContainer(stager.image, kubernetesServiceIp),
  );
  const administrator = findNamed(
    job.spec.template.spec.containers,
    'administrator',
  );
  administrator.terminationMessagePolicy = 'FallbackToLogsOnError';
  const deliveryIndex = administrator.args.findIndex((argument) =>
    argument.startsWith('--delivery='),
  );
  if (deliveryFile === undefined) {
    assert.equal(deliveryIndex, -1);
  } else {
    assert.ok(deliveryIndex >= 0);
    administrator.args[deliveryIndex] =
      `--delivery=/var/lib/qinglong3/security-administration-delivery/private/${deliveryFile}`;
  }
  return job;
}

function administrationFailureEvidence(snapshot) {
  const readinessStatus = snapshot.pod.status.initContainerStatuses?.find(
    (container) => container.name === 'wait-network-policy',
  );
  const readinessTerminated = readinessStatus?.state?.terminated;
  const inspectorStatus = snapshot.pod.status.initContainerStatuses?.find(
    (container) => container.name === 'inspect-input-authority',
  );
  const initStatus = snapshot.pod.status.initContainerStatuses?.find(
    (container) => container.name === 'stage-private-input',
  );
  const initTerminated = initStatus?.state?.terminated;
  const status = snapshot.pod.status.containerStatuses?.find(
    (container) => container.name === 'administrator',
  );
  const terminated = status?.state?.terminated;
  const evidence = {
    jobComplete: snapshot.complete,
    jobFailed: snapshot.failed,
    networkPolicyExitCode: readinessTerminated?.exitCode ?? null,
    networkPolicyReason:
      readinessTerminated?.reason ??
      readinessStatus?.state?.waiting?.reason ??
      null,
    initExitCode: initTerminated?.exitCode ?? null,
    initReason:
      initTerminated?.reason ?? initStatus?.state?.waiting?.reason ?? null,
    mainExitCode: terminated?.exitCode ?? null,
    mainReason: terminated?.reason ?? status?.state?.waiting?.reason ?? null,
  };
  let inputAuthority;
  try {
    const parsed = JSON.parse(
      inspectorStatus?.state?.terminated?.message?.trim() || '',
    );
    if (parsed.schema === 'qinglong/security-administration-input-authority@v1') {
      inputAuthority = parsed;
    }
  } catch {
    inputAuthority = 'unavailable';
  }
  const message = (
    initTerminated?.message || terminated?.message || ''
  ).trim();
  if (!message) return { ...evidence, inputAuthority };
  try {
    const parsed = JSON.parse(message);
    const allowedKeys = ['schemaVersion', 'component', 'event', 'name', 'code'];
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => !allowedKeys.includes(key))
    ) {
      return { ...evidence, inputAuthority, failureMessage: 'rejected' };
    }
    return { ...evidence, inputAuthority, failureMessage: parsed };
  } catch {
    return { ...evidence, inputAuthority, failureMessage: 'unparseable' };
  }
}

function migrationFailureEvidence(snapshot) {
  const status = snapshot.pod.status.containerStatuses?.find(
    (container) => container.name === 'migration',
  );
  const terminated = status?.state?.terminated;
  const evidence = {
    jobComplete: snapshot.complete,
    jobFailed: snapshot.failed,
    podPhase: snapshot.pod.status.phase ?? null,
    exitCode: terminated?.exitCode ?? null,
    reason: terminated?.reason ?? status?.state?.waiting?.reason ?? null,
  };
  const lines = (terminated?.message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  if (lines.length === 0) return evidence;
  let rejected = false;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const allowedKeys = ['schemaVersion', 'component', 'event', 'name', 'code'];
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => !allowedKeys.includes(key))
    ) {
      rejected = true;
      continue;
    }
    return { ...evidence, failureMessage: parsed };
  }
  return {
    ...evidence,
    failureMessage: rejected ? 'rejected' : 'unparseable',
  };
}

async function terminalJobSnapshot(fixture, name, timeoutMs = 180_000) {
  return (
    await waitFor(`${name} terminal`, timeoutMs, () => {
      const job = fixture.kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
      const complete = job.status.conditions?.some(
        (condition) =>
          condition.type === 'Complete' && condition.status === 'True',
      );
      const failed = job.status.conditions?.some(
        (condition) =>
          condition.type === 'Failed' && condition.status === 'True',
      );
      const pods = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `batch.kubernetes.io/job-name=${name}`,
      ]).items;
      const podFacts = pods.map((pod) => ({
        phase: pod.status.phase ?? null,
        nodeAssigned: typeof pod.spec.nodeName === 'string',
        init: (pod.status.initContainerStatuses ?? []).map((container) => ({
          name: container.name,
          waitingReason: container.state?.waiting?.reason ?? null,
          terminatedReason: container.state?.terminated?.reason ?? null,
          exitCode: container.state?.terminated?.exitCode ?? null,
        })),
        containers: (pod.status.containerStatuses ?? []).map((container) => ({
          name: container.name,
          waitingReason: container.state?.waiting?.reason ?? null,
          terminatedReason: container.state?.terminated?.reason ?? null,
          exitCode: container.state?.terminated?.exitCode ?? null,
        })),
      }));
      return (complete || failed) && pods.length === 1
        ? { ready: true, value: { job, pod: pods[0], complete, failed } }
        : {
            ready: false,
            fact: JSON.stringify({
              podCount: pods.length,
              job: {
                active: job.status?.active ?? 0,
                ready: job.status?.ready ?? 0,
                succeeded: job.status?.succeeded ?? 0,
                failed: job.status?.failed ?? 0,
              },
              pods: podFacts,
            }),
          };
    })
  ).value;
}

function deleteResource(fixture, resource) {
  fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'delete',
      resource,
      '--ignore-not-found=true',
      '--wait=true',
    ],
    { capture: true, quiet: true },
  );
}

function resourceAbsent(fixture, resource) {
  return (
    fixture.kubectl(['-n', NAMESPACE, 'get', resource], {
      capture: true,
      quiet: true,
      allowFailure: true,
    }).status !== 0
  );
}

async function runAdministrationJob({
  fixture,
  template,
  name,
  command,
  assertion,
  keyset,
  pepperKeyring,
  deliveryFile,
  expectedComplete,
  projectedMode,
  createdJobs,
  createdSecrets,
}) {
  const kubernetesServiceIp = fixture.kubectlJson([
    '-n',
    'default',
    'get',
    'service',
    'kubernetes',
  ]).spec.clusterIP;
  const inputSecretName = `${name}-input`;
  fixture.create({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: inputSecretName, namespace: NAMESPACE },
    immutable: true,
    type: 'Opaque',
    stringData: {
      'command.json': `${JSON.stringify(command)}\n`,
      'assertion.jwt': `${assertion}\n`,
      'keyset.json': `${JSON.stringify(keyset)}\n`,
      'pepper-keyring.json': `${JSON.stringify(pepperKeyring)}\n`,
    },
  });
  createdSecrets.add(inputSecretName);
  const job = administrationJob(template, {
    name,
    inputSecretName,
    deliveryFile,
    projectedMode,
    kubernetesServiceIp,
  });
  fixture.create(job);
  createdJobs.add(name);
  try {
    const snapshot = await terminalJobSnapshot(fixture, name);
    const failureEvidence = JSON.stringify(
      administrationFailureEvidence(snapshot),
    );
    assert.equal(snapshot.complete, expectedComplete, failureEvidence);
    assert.equal(snapshot.failed, !expectedComplete, failureEvidence);
    assert.equal(snapshot.job.spec.backoffLimit, 0);
    assert.equal(snapshot.job.spec.activeDeadlineSeconds, 300);
    assert.equal(snapshot.job.spec.ttlSecondsAfterFinished, 600);
    assert.equal(snapshot.pod.spec.serviceAccountName, NAME);
    assert.equal(snapshot.pod.spec.automountServiceAccountToken, false);
    assert.equal(
      snapshot.pod.spec.volumes.some((volume) =>
        volume.projected?.sources?.some(
          (source) => source.serviceAccountToken !== undefined,
        ),
      ),
      false,
    );
    const init = snapshot.pod.status.initContainerStatuses?.find(
      (container) => container.name === 'stage-private-input',
    );
    assert.ok(init?.state?.terminated);
    const main = snapshot.pod.status.containerStatuses?.find(
      (container) => container.name === 'administrator',
    );
    if (expectedComplete) {
      assert.equal(init.state.terminated.exitCode, 0);
      assert.equal(main?.state?.terminated?.exitCode, 0);
    } else {
      assert.notEqual(init.state.terminated.exitCode, 0);
      assert.equal(main?.state?.terminated, undefined);
      assert.equal(main?.state?.running, undefined);
    }
    return snapshot;
  } finally {
    deleteResource(fixture, `job/${name}`);
    createdJobs.delete(name);
    deleteResource(fixture, `secret/${inputSecretName}`);
    createdSecrets.delete(inputSecretName);
  }
}

function custodyEvidenceSource() {
  return String.raw`
const crypto=require('node:crypto');const fs=require('node:fs');const net=require('node:net');
const finish=(value,status)=>{fs.writeFileSync('/dev/termination-log',JSON.stringify(value),{encoding:'utf8',mode:0o600});process.exitCode=status};
const connect=(host,port)=>new Promise((resolve)=>{let settled=false;const socket=net.createConnection({host,port});const done=(ok)=>{if(settled)return;settled=true;socket.destroy();resolve(ok)};socket.setTimeout(3000);socket.once('connect',()=>done(true));socket.once('timeout',()=>done(false));socket.once('error',()=>done(false));});
(async()=>{let networkEvidence;try{const directory='/delivery/private';const expected=JSON.parse(process.argv[1]);const directoryStatus=fs.lstatSync(directory);if(!directoryStatus.isDirectory()||directoryStatus.isSymbolicLink()||(directoryStatus.mode&0o777)!==0o700||directoryStatus.uid!==process.geteuid())throw new Error('DIRECTORY');const names=fs.readdirSync(directory).sort();if(JSON.stringify(names)!==JSON.stringify(expected.map((entry)=>entry.name).sort()))throw new Error('COUNT');const files=[];for(const entry of expected){const file=directory+'/'+entry.name;const status=fs.lstatSync(file);if(!status.isFile()||status.isSymbolicLink()||(status.mode&0o777)!==0o600||status.uid!==process.geteuid()||status.nlink!==1||status.size<1||status.size>32768)throw new Error('FILE');const bytes=fs.readFileSync(file);try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));const keys=Object.keys(value).sort();const required=['credentialId','expiresAtMs','kind','mutationId','notBeforeAtMs','operation','requestId','schemaVersion','subject','token','version'].sort();if(JSON.stringify(keys)!==JSON.stringify(required)||value.schemaVersion!==1||value.kind!=='qinglong3-cluster-api-credential-delivery'||value.operation!==entry.operation||typeof value.token!=='string'||!/^ql3c_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/.test(value.token))throw new Error('SCHEMA');files.push({name:entry.name,operation:entry.operation,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex'),bytes:status.size,inode:String(status.ino),mtimeMs:status.mtimeMs});}finally{bytes.fill(0)}}const databaseConnected=await connect(process.argv[2],5432);const kubernetesApiConnected=await connect(process.argv[3],443);const publicInternetConnected=await connect('1.1.1.1',443);networkEvidence={databaseConnected,kubernetesApiConnected,publicInternetConnected};if(!databaseConnected||kubernetesApiConnected||publicInternetConnected)throw new Error('NETWORK');finish({schemaVersion:1,passed:true,directoryMode:'0700',fileMode:'0600',files,...networkEvidence},0)}catch(error){finish({schemaVersion:1,passed:false,code:error instanceof Error&&/^[A-Z]+$/.test(error.message)?error.message:'UNAVAILABLE',...(networkEvidence?{networkEvidence}: {})},1)}})();`;
}

async function runCustodyEvidence({
  fixture,
  adminImage,
  name,
  expected,
  kubernetesServiceIp,
  createdEvidenceJobs,
}) {
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 60,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': NAME,
            'app.kubernetes.io/component': 'security-administration',
            'ql3.live/evidence': 'credential-custody',
          },
        },
        spec: {
          serviceAccountName: NAME,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            fsGroupChangePolicy: 'OnRootMismatch',
            seccompProfile: { type: 'RuntimeDefault' },
          },
          initContainers: [
            networkPolicyReadinessContainer(adminImage, kubernetesServiceIp),
          ],
          containers: [
            {
              name: 'evidence',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '-e',
                custodyEvidenceSource(),
                JSON.stringify(expected),
                'ql3-postgres-rw.qinglong3-system.svc',
                kubernetesServiceIp,
              ],
              terminationMessagePolicy: 'File',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '5m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
              volumeMounts: [
                {
                  name: 'delivery',
                  mountPath: '/delivery',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'delivery',
              persistentVolumeClaim: { claimName: DELIVERY_CLAIM },
            },
          ],
        },
      },
    },
  });
  createdEvidenceJobs.add(name);
  try {
    const snapshot = await terminalJobSnapshot(fixture, name, 180_000);
    const state = snapshot.pod.status.containerStatuses?.[0]?.state?.terminated;
    const statusEvidence = state?.message || JSON.stringify({
      exitCode: state?.exitCode ?? null,
      reason: state?.reason ?? null,
    });
    assert.equal(snapshot.complete, true, statusEvidence);
    assert.equal(snapshot.failed, false, statusEvidence);
    assert.equal(state?.exitCode, 0, state?.message);
    const evidence = JSON.parse(state.message);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.passed, true);
    assert.equal(evidence.databaseConnected, true);
    assert.equal(evidence.kubernetesApiConnected, false);
    assert.equal(evidence.publicInternetConnected, false);
    return evidence;
  } finally {
    deleteResource(fixture, `job/${name}`);
    createdEvidenceJobs.delete(name);
  }
}

function runtimeFileMaterializationSource({
  postgresDirectory = '/var/run/secrets/qinglong3/postgres-projected',
  keyringDirectory = '/var/run/secrets/qinglong3/api-credential-projected',
  targetDirectory = '/var/run/secrets/qinglong3/runtime',
} = {}) {
  for (const value of [
    postgresDirectory,
    keyringDirectory,
    targetDirectory,
  ]) {
    assert.equal(path.isAbsolute(value), true);
  }
  return [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    `const target=${JSON.stringify(targetDirectory)}`,
    `const files=[[${JSON.stringify(postgresDirectory + '/..data')},'ca.crt'],[${JSON.stringify(keyringDirectory + '/..data')},'keyring.json']]`,
    "for(const [directory,name] of files){const source=fs.realpathSync(directory);const output=path.join(target,name);fs.copyFileSync(path.join(source,name),output,fs.constants.COPYFILE_EXCL);fs.chmodSync(output,0o400)}",
  ].join(';');
}

function clusterControlResources(controlImage) {
  const labels = Object.freeze({
    'app.kubernetes.io/name': CONTROL_NAME,
    'app.kubernetes.io/component': 'control-plane',
    'app.kubernetes.io/part-of': 'qinglong3',
  });
  return Object.freeze([
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: CONTROL_NAME, namespace: NAMESPACE, labels },
      spec: {
        selector: labels,
        ports: [{ name: 'http', port: 5800, targetPort: 'http' }],
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: CONTROL_NAME, namespace: NAMESPACE, labels },
      spec: {
        replicas: 2,
        minReadySeconds: 2,
        progressDeadlineSeconds: 300,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
        },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: 'ql3-cluster-control',
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 20,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              fsGroup: 10001,
              fsGroupChangePolicy: 'OnRootMismatch',
              seccompProfile: { type: 'RuntimeDefault' },
            },
            affinity: {
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [{
                  topologyKey: 'kubernetes.io/hostname',
                  labelSelector: { matchLabels: labels },
                }],
              },
            },
            containers: [{
              name: 'cluster-control',
              image: controlImage,
              imagePullPolicy: 'Never',
              terminationMessagePolicy: 'FallbackToLogsOnError',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              env: [
                { name: 'QL_DEPLOYMENT_PROFILE', value: 'cluster-control' },
                { name: 'QL3_CLUSTER_CONTROL_ENABLED', value: 'true' },
                { name: 'QL3_CLUSTER_HTTP_HOST', value: '0.0.0.0' },
                { name: 'QL3_CLUSTER_HTTP_PORT', value: '5800' },
                { name: 'QL3_CLUSTER_HTTP_DRAIN_TIMEOUT_MS', value: '10000' },
                { name: 'QL3_WORKER_INGRESS_ENABLED', value: 'false' },
                { name: 'QL3_POSTGRES_TLS_MODE', value: 'verify-full' },
                {
                  name: 'QL3_POSTGRES_TLS_CA_FILE',
                  value: '/var/run/secrets/qinglong3/runtime/ca.crt',
                },
                {
                  name: 'QL3_POSTGRES_TLS_SERVERNAME',
                  value: 'ql3-postgres-rw.qinglong3-system.svc',
                },
                { name: 'QL3_POSTGRES_MAX_CONNECTIONS', value: '2' },
                {
                  name: 'QL3_POSTGRES_APPLICATION_NAME',
                  value: 'qinglong3-security-live-control',
                },
                {
                  name: 'QL3_CLUSTER_REPLICA_ID',
                  valueFrom: {
                    fieldRef: {
                      apiVersion: 'v1',
                      fieldPath: 'metadata.name',
                    },
                  },
                },
                {
                  name: 'QL3_POSTGRES_RUNTIME_URL',
                  valueFrom: {
                    secretKeyRef: {
                      name: CONTROL_RUNTIME_SECRET,
                      key: 'postgres-runtime-url',
                    },
                  },
                },
                {
                  name: 'QL3_API_CREDENTIAL_PEPPER_KEYRING_FILE',
                  value: '/var/run/secrets/qinglong3/runtime/keyring.json',
                },
              ],
              ports: [{ name: 'http', containerPort: 5800 }],
              startupProbe: {
                httpGet: { path: '/livez', port: 'http' },
                periodSeconds: 2,
                timeoutSeconds: 1,
                failureThreshold: 60,
              },
              readinessProbe: {
                httpGet: { path: '/readyz', port: 'http' },
                periodSeconds: 2,
                timeoutSeconds: 1,
                failureThreshold: 10,
              },
              resources: {
                requests: { cpu: '25m', memory: '96Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                {
                  name: 'runtime-private',
                  mountPath: '/var/run/secrets/qinglong3/runtime',
                  readOnly: true,
                },
              ],
            }],
            initContainers: [{
              name: 'materialize-runtime-files',
              image: controlImage,
              imagePullPolicy: 'Never',
              command: [
                'node',
                '-e',
                runtimeFileMaterializationSource(),
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
              volumeMounts: [
                {
                  name: 'postgres-ca-projected',
                  mountPath: '/var/run/secrets/qinglong3/postgres-projected',
                  readOnly: true,
                },
                {
                  name: 'api-credential-keyring-projected',
                  mountPath: '/var/run/secrets/qinglong3/api-credential-projected',
                  readOnly: true,
                },
                {
                  name: 'runtime-private',
                  mountPath: '/var/run/secrets/qinglong3/runtime',
                },
              ],
            }],
            volumes: [
              {
                name: 'tmp',
                emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
              },
              {
                name: 'postgres-ca-projected',
                secret: {
                  secretName: 'ql3-postgres-ca',
                  defaultMode: 292,
                  items: [{ key: 'ca.crt', path: 'ca.crt' }],
                },
              },
              {
                name: 'api-credential-keyring-projected',
                secret: {
                  secretName: CONTROL_RUNTIME_SECRET,
                  defaultMode: 292,
                  items: [{
                    key: 'api-credential-pepper-keyring.json',
                    path: 'keyring.json',
                  }],
                },
              },
              {
                name: 'runtime-private',
                emptyDir: { medium: 'Memory', sizeLimit: '1Mi' },
              },
            ],
          },
        },
      },
    },
  ]);
}

function applyControlRuntimeSecret(fixture, runtimeDatabaseUrl, keyring) {
  applySecret(fixture, CONTROL_RUNTIME_SECRET, 'Opaque', {
    'postgres-runtime-url': runtimeDatabaseUrl,
    'api-credential-pepper-keyring.json': `${JSON.stringify(keyring)}\n`,
  });
}

function controlTerminationFact(message) {
  if (typeof message !== 'string' || message.length < 1 || message.length > 4096) {
    return 'rejected';
  }
  const lines = message.trim().split('\n');
  try {
    const fact = JSON.parse(lines.at(-1));
    const keys = Object.keys(fact).sort();
    const expected = [
      'component',
      'event',
      'level',
      'name',
      'schemaVersion',
      ...(fact.code === undefined ? [] : ['code']),
    ].sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(expected) ||
      fact.schemaVersion !== 1 ||
      fact.component !== 'qinglong3-cluster-control' ||
      fact.level !== 'error' ||
      fact.event !== 'process_failed' ||
      typeof fact.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(fact.name) ||
      (fact.code !== undefined &&
        (typeof fact.code !== 'string' ||
          !/^[A-Z][A-Z0-9_]{0,127}$/.test(fact.code)))
    ) {
      return 'rejected';
    }
    return Object.freeze({
      name: fact.name,
      ...(fact.code === undefined ? {} : { code: fact.code }),
    });
  } catch {
    return 'rejected';
  }
}

function controlRolloutFailureEvidence(fixture) {
  const deployment = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'deployment',
    CONTROL_NAME,
  ]);
  const pods = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    `app.kubernetes.io/name=${CONTROL_NAME}`,
  ]).items;
  return Object.freeze({
    deployment: Object.freeze({
      generation: deployment.metadata.generation ?? null,
      observedGeneration: deployment.status?.observedGeneration ?? null,
      replicas: deployment.status?.replicas ?? 0,
      updatedReplicas: deployment.status?.updatedReplicas ?? 0,
      availableReplicas: deployment.status?.availableReplicas ?? 0,
      unavailableReplicas: deployment.status?.unavailableReplicas ?? 0,
      conditions: Object.freeze(
        (deployment.status?.conditions ?? []).map((condition) =>
          Object.freeze({
            type: condition.type,
            status: condition.status,
            reason: condition.reason ?? null,
          }),
        ),
      ),
    }),
    pods: Object.freeze(
      pods.map((pod) =>
        Object.freeze({
          name: pod.metadata.name,
          node: pod.spec.nodeName ?? null,
          phase: pod.status?.phase ?? null,
          conditions: Object.freeze(
            (pod.status?.conditions ?? []).map((condition) =>
              Object.freeze({
                type: condition.type,
                status: condition.status,
                reason: condition.reason ?? null,
              }),
            ),
          ),
          containers: Object.freeze(
            (pod.status?.containerStatuses ?? []).map((container) => {
              const terminated =
                container.state?.terminated ??
                container.lastState?.terminated;
              return Object.freeze({
                name: container.name,
                ready: container.ready,
                restartCount: container.restartCount,
                state: container.state?.waiting
                  ? Object.freeze({
                      kind: 'waiting',
                      reason: container.state.waiting.reason ?? null,
                    })
                  : container.state?.running
                    ? Object.freeze({ kind: 'running' })
                    : terminated
                      ? Object.freeze({
                          kind: 'terminated',
                          reason: terminated.reason ?? null,
                          exitCode: terminated.exitCode,
                        })
                      : Object.freeze({ kind: 'unknown' }),
                failure:
                  terminated?.message === undefined
                    ? null
                    : controlTerminationFact(terminated.message),
              });
            }),
          ),
        }),
      ),
    ),
  });
}

async function waitForControlRollout(fixture, restart) {
  if (restart) {
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'rollout',
      'restart',
      `deployment/${CONTROL_NAME}`,
    ]);
  }
  const rollout = fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'rollout',
      'status',
      `deployment/${CONTROL_NAME}`,
      '--timeout=5m',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (rollout.status !== 0) {
    throw new Error(
      `Cluster Control rollout unavailable: ${JSON.stringify(
        controlRolloutFailureEvidence(fixture),
      )}`,
    );
  }
  return (
    await waitFor('two ready Cluster Control replicas', 120_000, () => {
      const deployment = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'deployment',
        CONTROL_NAME,
      ]);
      const pods = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/name=${CONTROL_NAME}`,
      ]).items;
      const ready = pods.filter(podReady);
      return deployment.status.availableReplicas === 2 && ready.length === 2
        ? {
            ready: true,
            value: Object.freeze({
              replicas: ready.length,
              nodes: Object.freeze(
                ready.map((pod) => pod.spec.nodeName).sort(),
              ),
            }),
          }
        : {
            ready: false,
            fact: JSON.stringify({
              availableReplicas: deployment.status.availableReplicas ?? 0,
              readyPods: ready.length,
            }),
          };
    })
  ).value;
}

function credentialAuthenticationProbeSource() {
  return String.raw`
const fs=require('node:fs');const http=require('node:http');
const finish=(value,status)=>{fs.writeFileSync('/dev/termination-log',JSON.stringify(value),{encoding:'utf8',mode:0o600});process.exitCode=status};
const sleep=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
const request=(token,requestId)=>new Promise((resolve)=>{let settled=false;const done=(status)=>{if(settled)return;settled=true;resolve(status)};const call=http.get({host:'ql3-security-live-control',port:5800,path:'/api/v3/projects/prj_default/runs?limit=1',headers:{authorization:'Bearer '+token,'x-request-id':requestId}},(response)=>{const status=response.statusCode??null;response.resume();response.once('end',()=>done(status));response.once('error',()=>done(null))});call.setTimeout(5000,()=>{call.destroy();done(null)});call.once('error',()=>done(null))});
(async()=>{let bytes;try{const file='/delivery/private/'+process.argv[1];const expected=Number(process.argv[2]);const requestId=process.argv[3];const status=fs.lstatSync(file);if(!status.isFile()||status.isSymbolicLink()||(status.mode&0o777)!==0o600||status.uid!==process.geteuid()||status.size<1||status.size>32768)throw new Error('FILE');bytes=fs.readFileSync(file);const delivery=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(typeof delivery.token!=='string'||!/^ql3c_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/.test(delivery.token)||!Number.isSafeInteger(delivery.notBeforeAtMs)||!Number.isSafeInteger(delivery.expiresAtMs))throw new Error('SCHEMA');const wait=Math.max(0,delivery.notBeforeAtMs-Date.now()+1000);if(wait>360000||Date.now()+wait>=delivery.expiresAtMs)throw new Error('LIFETIME');if(wait>0)await sleep(wait);const observed=await request(delivery.token,requestId);if(observed!==expected)throw Object.assign(new Error('STATUS'),{observed});finish({schemaVersion:1,passed:true,expectedStatus:expected,observedStatus:observed},0)}catch(error){finish({schemaVersion:1,passed:false,code:error instanceof Error&&/^[A-Z]+$/.test(error.message)?error.message:'UNAVAILABLE',observedStatus:Number.isInteger(error?.observed)?error.observed:null},1)}finally{bytes?.fill(0)}})();`;
}

async function runCredentialAuthenticationProbe({
  fixture,
  adminImage,
  name,
  deliveryFile,
  expectedStatus,
  requestId,
  createdEvidenceJobs,
}) {
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 420,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': NAME,
            'app.kubernetes.io/component': 'credential-authentication-evidence',
            'ql3.live/evidence': 'credential-authentication',
          },
        },
        spec: {
          serviceAccountName: NAME,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            fsGroupChangePolicy: 'OnRootMismatch',
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [{
            name: 'authentication-evidence',
            image: adminImage,
            imagePullPolicy: 'Never',
            command: [
              'node',
              '-e',
              credentialAuthenticationProbeSource(),
              deliveryFile,
              String(expectedStatus),
              requestId,
            ],
            terminationMessagePolicy: 'File',
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
            resources: {
              requests: { cpu: '5m', memory: '16Mi' },
              limits: { cpu: '100m', memory: '64Mi' },
            },
            volumeMounts: [{
              name: 'delivery',
              mountPath: '/delivery',
              readOnly: true,
            }],
          }],
          volumes: [{
            name: 'delivery',
            persistentVolumeClaim: { claimName: DELIVERY_CLAIM },
          }],
        },
      },
    },
  });
  createdEvidenceJobs.add(name);
  try {
    const snapshot = await terminalJobSnapshot(fixture, name, 480_000);
    const state = snapshot.pod.status.containerStatuses?.[0]?.state?.terminated;
    const statusEvidence = state?.message || JSON.stringify({
      exitCode: state?.exitCode ?? null,
      reason: state?.reason ?? null,
    });
    assert.equal(snapshot.complete, true, statusEvidence);
    assert.equal(snapshot.failed, false, statusEvidence);
    assert.equal(state?.exitCode, 0, state?.message);
    const evidence = JSON.parse(state.message);
    assert.deepEqual(evidence, {
      schemaVersion: 1,
      passed: true,
      expectedStatus,
      observedStatus: expectedStatus,
    });
    return evidence;
  } finally {
    deleteResource(fixture, `job/${name}`);
    createdEvidenceJobs.delete(name);
  }
}

async function provisionDeliveryVolume({
  fixture,
  adminImage,
  createdEvidenceJobs,
}) {
  const name = 'ql3-security-live-delivery-provision';
  fixture.create({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/name': NAME,
        'app.kubernetes.io/component': 'security-administration',
        'app.kubernetes.io/part-of': 'qinglong3',
        'ql3.live/fixture-role': 'storage-provision',
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': NAME,
            'app.kubernetes.io/component': 'security-administration',
            'app.kubernetes.io/part-of': 'qinglong3',
            'ql3.live/fixture-role': 'storage-provision',
          },
        },
        spec: {
          serviceAccountName: NAME,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'storage-provision',
              image: adminImage,
              imagePullPolicy: 'Never',
              command: ['node', '-e', deliveryVolumeProvisionSource()],
              terminationMessagePolicy: 'File',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '5m', memory: '16Mi' },
                limits: { cpu: '100m', memory: '64Mi' },
              },
              volumeMounts: [{ name: 'delivery', mountPath: '/delivery' }],
            },
          ],
          volumes: [
            {
              name: 'delivery',
              persistentVolumeClaim: { claimName: DELIVERY_CLAIM },
            },
          ],
        },
      },
    },
  });
  createdEvidenceJobs.add(name);
  try {
    const snapshot = await terminalJobSnapshot(fixture, name, 180_000);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.failed, false);
    const state = snapshot.pod.status.containerStatuses?.[0]?.state?.terminated;
    assert.equal(state?.exitCode, 0, state?.message);
    const evidence = JSON.parse(state.message);
    assert.deepEqual(evidence, {
      schema: 'qinglong/security-administration-delivery-volume-provision@v1',
      beforeMode: '2777',
      afterMode: '2770',
      uid: 0,
      gid: 10001,
      passed: true,
    });
    return evidence;
  } finally {
    deleteResource(fixture, `job/${name}`);
    createdEvidenceJobs.delete(name);
  }
}

function canI(fixture, verb, resource) {
  const result = fixture.kubectl(
    [
      'auth',
      'can-i',
      verb,
      resource,
      '-n',
      NAMESPACE,
      `--as=system:serviceaccount:${NAMESPACE}:${NAME}`,
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  const decision = result.stdout.trim();
  assert.ok(decision === 'yes' || decision === 'no');
  assert.equal(result.status === 0, decision === 'yes');
  return decision;
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  if (process.env.QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE=1',
    );
  }
  const operatorManifestFile = process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE;
  if (!operatorManifestFile) {
    throw new Error('QL3_CNPG_OPERATOR_MANIFEST_FILE is required');
  }
  const reviewedManifest = reviewedOperatorManifest(operatorManifestFile);
  const fixture = new K3sDockerLiveFixture({ prefix: 'ql3-security-live' });
  const suffix =
    process.pid.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const adminImage = `${ADMIN_IMAGE_BASE}:${suffix}`;
  const controlImage = `${CONTROL_IMAGE_BASE}:${suffix}`;
  let adminImageBuilt = false;
  let controlImageBuilt = false;
  const createdJobs = new Set();
  const createdSecrets = new Set();
  const createdEvidenceJobs = new Set();
  try {
    const nodes = await fixture.start();
    for (const node of fixture.nodes) {
      for (const setting of [
        'net.ipv4.ip_forward=1',
        'net.bridge.bridge-nf-call-iptables=1',
      ]) {
        const configured = fixture.dockerRun(
          ['exec', node, 'sysctl', '-w', setting],
          { capture: true, quiet: true },
        ).stdout;
        assert.equal(configured.trim().endsWith(' = 1'), true);
      }
    }
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    assert.ok(['amd64', 'arm64'].includes(architecture));
    for (const reviewedImage of [OPERATOR_IMAGE, POSTGRES_IMAGE]) {
      run(fixture.docker, ['pull', reviewedImage]);
      const inspected = fixture.inspectImage(reviewedImage);
      assert.ok(
        inspected.RepoDigests?.some((entry) =>
          entry.endsWith(`@${imageDigest(reviewedImage)}`),
        ),
      );
      const preloadTag = imageTag(reviewedImage);
      run(fixture.docker, ['tag', reviewedImage, preloadTag]);
      fixture.loadImage(preloadTag, `${path.basename(preloadTag)}.tar`);
    }

    const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
      quiet: true,
    }).stdout;
    for (const [dockerfile, image, archive] of [
      [
        'deploy/containers/ql3-cluster-admin/Dockerfile',
        adminImage,
        'security-administration-admin.tar',
      ],
      [
        'deploy/containers/ql3-cluster-control/Dockerfile',
        controlImage,
        'security-administration-control.tar',
      ],
    ]) {
      run(fixture.docker, [
        'build',
        '--file',
        dockerfile,
        '--tag',
        image,
        '--build-arg',
        `SOURCE_REVISION=${sourceRevision}`,
        '.',
      ]);
      if (image === adminImage) adminImageBuilt = true;
      else controlImageBuilt = true;
      fixture.loadImage(image, archive);
    }
    const adminImageInfo = fixture.inspectImage(adminImage);
    const controlImageInfo = fixture.inspectImage(controlImage);
    const postgresImageInfo = fixture.inspectImage(POSTGRES_IMAGE);
    const k3sImageInfo = fixture.inspectImage(fixture.k3sImage);

    fixture.kubectl(['apply', '--server-side', '-f', reviewedManifest]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'set',
      'image',
      'deployment/cnpg-controller-manager',
      `manager=${imageTag(OPERATOR_IMAGE)}`,
    ]);
    fixture.kubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusters.postgresql.cnpg.io',
      'crd/databaseroles.postgresql.cnpg.io',
      'crd/databases.postgresql.cnpg.io',
      '--timeout=5m',
    ]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '--timeout=5m',
    ]);

    fixture.kubectl([
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/namespace.yaml',
    ]);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/service-account.yaml',
    ]);
    const passwords = Object.fromEntries(
      ROLE_NAMES.map((role) => [role, randomSecret()]),
    );
    for (const role of ROLE_NAMES) {
      applySecret(
        fixture,
        `ql3-postgres-${role
          .replace(/^ql3_/, '')
          .replaceAll('_', '-')}-auth`,
        'kubernetes.io/basic-auth',
        { username: role, password: passwords[role] },
      );
    }
    const databaseManifest = fixture
      .kubectl(
        ['kustomize', 'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg'],
        { capture: true, quiet: true },
      )
      .stdout.replace(POSTGRES_IMAGE, imageTag(POSTGRES_IMAGE));
    assert.equal(databaseManifest.includes(POSTGRES_IMAGE), false);
    fixture.kubectl(['apply', '-f', '-'], { input: `${databaseManifest}\n` });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Ready',
      `cluster/${POSTGRES_CLUSTER}`,
      '--timeout=20m',
    ]);
    const databasePods = (
      await waitFor('three ready CloudNativePG instances', 600_000, () => {
        const pods = fixture
          .kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'pods',
            '-l',
            `cnpg.io/cluster=${POSTGRES_CLUSTER}`,
          ])
          .items.filter(podReady);
        return pods.length === 3
          ? { ready: true, value: pods }
          : { ready: false, fact: `${pods.length}/3 Ready database Pods` };
      })
    ).value;
    await waitFor('CloudNativePG managed resources', 5 * 60_000, () => {
      const roles = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'databaseroles.postgresql.cnpg.io',
      ]).items;
      const readyRoles = roles.filter(
        (role) =>
          role.status?.applied === true &&
          role.status?.observedGeneration === role.metadata.generation,
      );
      const database = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'database.postgresql.cnpg.io/ql3-postgres-qinglong',
      ]);
      const databaseReady =
        database.status?.applied === true &&
        database.status?.observedGeneration === database.metadata.generation;
      return readyRoles.length === ROLE_NAMES.length && databaseReady
        ? { ready: true, value: true }
        : {
            ready: false,
            fact: `${readyRoles.length}/${ROLE_NAMES.length} roles applied; ` +
              `databaseApplied=${String(databaseReady)}`,
          };
    });

    const migrationManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-control',
      controlImage,
    );
    const migrationJob = yaml.load(migrationManifest);
    assert.equal(migrationJob?.kind, 'Job');
    const migrationContainer = findNamed(
      migrationJob.spec.template.spec.containers,
      'migration',
    );
    migrationContainer.terminationMessagePolicy = 'FallbackToLogsOnError';
    fixture.create(migrationJob);
    const migrationSnapshot = await terminalJobSnapshot(
      fixture,
      'ql3-cluster-migration',
      10 * 60_000,
    );
    const migrationEvidence = JSON.stringify(
      migrationFailureEvidence(migrationSnapshot),
    );
    assert.equal(migrationSnapshot.complete, true, migrationEvidence);
    assert.equal(migrationSnapshot.failed, false, migrationEvidence);
    const primary = currentPrimaryPod(fixture);
    const migrationState = JSON.parse(
      psql(
        fixture,
        primary.metadata.name,
        [
          'SELECT json_build_object(',
          `  'migrationCount', (SELECT count(*)::integer FROM "ql3"."schema_migrations"),`,
          `  'controlCoreCapability', (SELECT contract_version::integer FROM "ql3"."schema_capabilities" WHERE contract_name = 'control-core'),`,
          `  'postgresVersionNumber', current_setting('server_version_num')::integer)`,
        ].join('\n'),
      ),
    );
    assert.deepEqual(migrationState, {
      migrationCount: 71,
      controlCoreCapability: 70,
      postgresVersionNumber: 180004,
    });

    const baseResources = renderedResources(
      fixture,
      'deploy/kubernetes/ql3-cluster/operations/security-administration/cloudnative-pg',
      adminImage,
    );
    const deliveryResources = renderedResources(
      fixture,
      'deploy/kubernetes/ql3-cluster/operations/security-administration/cloudnative-pg-credential-delivery',
      adminImage,
    );
    const serviceAccount = namedResource(baseResources, 'ServiceAccount', NAME);
    const networkPolicy = namedResource(baseResources, 'NetworkPolicy', NAME);
    const baseTemplate = namedResource(baseResources, 'Job', NAME);
    const deliveryTemplate = namedResource(deliveryResources, 'Job', NAME);
    fixture.apply(serviceAccount);
    fixture.apply(networkPolicy);
    fixture.create({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: DELIVERY_CLAIM, namespace: NAMESPACE },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '16Mi' } },
      },
    });
    const deliveryProvision = await provisionDeliveryVolume({
      fixture,
      adminImage,
      createdEvidenceJobs,
    });

    const values = Object.freeze({
      subject: Object.freeze({ type: 'api_app', id: `d406-live-${suffix}` }),
      identityMutationId: crypto.randomUUID(),
      registerRequestId: `d406-register-${suffix}`,
    });
    const oldCredential = Object.freeze({
      subject: values.subject,
      credentialId: `d407-old-${suffix}`,
      issueMutationId: crypto.randomUUID(),
      revokeMutationId: crypto.randomUUID(),
      issueRequestId: `d407-old-issue-${suffix}`,
      revokeRequestId: `d407-old-revoke-${suffix}`,
    });
    const newCredential = Object.freeze({
      subject: values.subject,
      credentialId: `d407-new-${suffix}`,
      issueMutationId: crypto.randomUUID(),
      rotateMutationId: crypto.randomUUID(),
      issueRequestId: `d407-new-issue-${suffix}`,
      rotateRequestId: `d407-new-rotate-${suffix}`,
    });
    const authenticationRequestIds = Object.freeze({
      oldBeforeActivation: `d407-auth-old-before-${suffix}`,
      oldDuringOverlap: `d407-auth-old-overlap-${suffix}`,
      newDuringOverlap: `d407-auth-new-overlap-${suffix}`,
      oldAfterConvergence: `d407-auth-old-contracted-${suffix}`,
      newAfterContraction: `d407-auth-new-contracted-${suffix}`,
    });
    const key = identity.reviewedKey('security-administration-live-key-1');
    const keyset = identity.keyset(1, [key]);
    const oldPepperKeyId = 'd407-old';
    const newPepperKeyId = 'd407-new';
    const oldPepper = randomSecret();
    const newPepper = randomSecret();
    const overlapOldActive = apiCredentialPepperKeyring(oldPepperKeyId, [
      { pepperKeyId: oldPepperKeyId, pepper: oldPepper },
      { pepperKeyId: newPepperKeyId, pepper: newPepper },
    ]);
    const overlapNewActive = apiCredentialPepperKeyring(newPepperKeyId, [
      { pepperKeyId: oldPepperKeyId, pepper: oldPepper },
      { pepperKeyId: newPepperKeyId, pepper: newPepper },
    ]);
    const contractedNew = apiCredentialPepperKeyring(newPepperKeyId, [
      { pepperKeyId: newPepperKeyId, pepper: newPepper },
    ]);
    const register = identityRegisterCommand(values);
    const revokeOld = credentialRevokeCommand({
      ...oldCredential,
      expectedCurrentVersion: 1,
    });
    const runtimeDatabaseUrl =
      `postgresql://ql3_runtime:${passwords.ql3_runtime}` +
      '@ql3-postgres-rw.qinglong3-system.svc:5432/qinglong';
    applyControlRuntimeSecret(
      fixture,
      runtimeDatabaseUrl,
      overlapOldActive,
    );
    for (const resource of clusterControlResources(controlImage)) {
      fixture.apply(resource);
    }
    const controlBeforeActivation = await waitForControlRollout(
      fixture,
      false,
    );
    assert.equal(new Set(controlBeforeActivation.nodes).size, 2);

    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-invalid-input',
      command: register,
      assertion: identity.assertion(key, 'invalid-input'),
      keyset,
      pepperKeyring: overlapOldActive,
      expectedComplete: false,
      projectedMode: 0o444,
      createdJobs,
      createdSecrets,
    });
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-register',
      command: register,
      assertion: identity.assertion(key, 'register'),
      keyset,
      pepperKeyring: overlapOldActive,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-audit',
      command: auditListCommand(),
      assertion: identity.assertion(key, 'audit'),
      keyset,
      pepperKeyring: overlapOldActive,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const oldIssueNotBeforeAtMs = Date.now() + 2 * 60 * 1000;
    const issueOld = credentialIssueCommand({
      ...oldCredential,
      notBeforeAtMs: oldIssueNotBeforeAtMs,
      expiresAtMs: oldIssueNotBeforeAtMs + 60 * 60 * 1000,
    });
    const oldIssueAssertion = identity.assertion(
      key,
      'old-issue-response-loss',
    );
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-old-issue',
      command: issueOld,
      assertion: oldIssueAssertion,
      keyset,
      pepperKeyring: overlapOldActive,
      deliveryFile: 'old-issue.json',
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const kubernetesServiceIp = fixture.kubectlJson([
      '-n',
      'default',
      'get',
      'service',
      'kubernetes',
    ]).spec.clusterIP;
    const issuedEvidence = await runCustodyEvidence({
      fixture,
      adminImage,
      name: 'ql3-security-live-evidence-issued',
      expected: [{ name: 'old-issue.json', operation: 'credential.issue' }],
      kubernetesServiceIp,
      createdEvidenceJobs,
    });
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-old-issue-replay',
      command: issueOld,
      assertion: oldIssueAssertion,
      keyset,
      pepperKeyring: overlapOldActive,
      deliveryFile: 'old-issue.json',
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const replayEvidence = await runCustodyEvidence({
      fixture,
      adminImage,
      name: 'ql3-security-live-evidence-replay',
      expected: [{ name: 'old-issue.json', operation: 'credential.issue' }],
      kubernetesServiceIp,
      createdEvidenceJobs,
    });
    assert.deepEqual(replayEvidence.files, issuedEvidence.files);
    const oldAuthenticationBeforeActivation =
      await runCredentialAuthenticationProbe({
        fixture,
        adminImage,
        name: 'ql3-security-live-auth-old-before-activate',
        deliveryFile: 'old-issue.json',
        expectedStatus: 403,
        requestId: authenticationRequestIds.oldBeforeActivation,
        createdEvidenceJobs,
      });
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-old-references-before-activate',
      command: pepperReferencesCommand(oldPepperKeyId),
      assertion: identity.assertion(key, 'old-references-before-activate'),
      keyset,
      pepperKeyring: overlapOldActive,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const referencesBeforeActivate = Number(
      psql(
        fixture,
        currentPrimaryPod(fixture).metadata.name,
        `SELECT count(*)::integer FROM "ql3"."api_credentials" current_record WHERE credential_id = ${sqlString(
          oldCredential.credentialId,
        )} AND pepper_key_id = ${sqlString(
          oldPepperKeyId,
        )} AND state = 'active' AND expires_at_ms > (extract(epoch FROM statement_timestamp()) * 1000)::bigint AND NOT EXISTS (SELECT 1 FROM "ql3"."api_credentials" newer WHERE newer.credential_id = current_record.credential_id AND newer.version > current_record.version)`,
      ),
    );
    assert.equal(referencesBeforeActivate, 1);
    applyControlRuntimeSecret(
      fixture,
      runtimeDatabaseUrl,
      overlapNewActive,
    );
    const controlDuringOverlap = await waitForControlRollout(fixture, true);
    assert.equal(new Set(controlDuringOverlap.nodes).size, 2);
    const oldAuthenticationDuringOverlap =
      await runCredentialAuthenticationProbe({
        fixture,
        adminImage,
        name: 'ql3-security-live-auth-old-overlap',
        deliveryFile: 'old-issue.json',
        expectedStatus: 403,
        requestId: authenticationRequestIds.oldDuringOverlap,
        createdEvidenceJobs,
      });
    const newIssueNotBeforeAtMs = Date.now() + 2 * 60 * 1000;
    const issueNew = credentialIssueCommand({
      ...newCredential,
      notBeforeAtMs: newIssueNotBeforeAtMs,
      expiresAtMs: newIssueNotBeforeAtMs + 60 * 60 * 1000,
    });
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-new-issue',
      command: issueNew,
      assertion: identity.assertion(key, 'new-issue'),
      keyset,
      pepperKeyring: overlapNewActive,
      deliveryFile: 'new-issue.json',
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const newRotateNotBeforeAtMs = Date.now() + 2 * 60 * 1000;
    const rotateNew = credentialRotateCommand({
      ...newCredential,
      notBeforeAtMs: newRotateNotBeforeAtMs,
      expiresAtMs: newRotateNotBeforeAtMs + 60 * 60 * 1000,
    });
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-new-rotate',
      command: rotateNew,
      assertion: identity.assertion(key, 'new-rotate'),
      keyset,
      pepperKeyring: overlapNewActive,
      deliveryFile: 'new-rotate.json',
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const newAuthenticationDuringOverlap =
      await runCredentialAuthenticationProbe({
        fixture,
        adminImage,
        name: 'ql3-security-live-auth-new-overlap',
        deliveryFile: 'new-rotate.json',
        expectedStatus: 403,
        requestId: authenticationRequestIds.newDuringOverlap,
        createdEvidenceJobs,
      });
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-old-references-after-activate',
      command: pepperReferencesCommand(oldPepperKeyId),
      assertion: identity.assertion(key, 'old-references-after-activate'),
      keyset,
      pepperKeyring: overlapNewActive,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const referencesAfterActivate = Number(
      psql(
        fixture,
        currentPrimaryPod(fixture).metadata.name,
        `SELECT count(*)::integer FROM "ql3"."api_credentials" current_record WHERE credential_id = ${sqlString(
          oldCredential.credentialId,
        )} AND pepper_key_id = ${sqlString(
          oldPepperKeyId,
        )} AND version = (SELECT max(version) FROM "ql3"."api_credentials" WHERE credential_id = current_record.credential_id) AND state = 'active' AND expires_at_ms > (extract(epoch FROM statement_timestamp()) * 1000)::bigint`,
      ),
    );
    assert.equal(referencesAfterActivate, 1);
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-old-revoke',
      command: revokeOld,
      assertion: identity.assertion(key, 'old-revoke'),
      keyset,
      pepperKeyring: overlapNewActive,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-old-references-after-converge',
      command: pepperReferencesCommand(oldPepperKeyId),
      assertion: identity.assertion(key, 'old-references-after-converge'),
      keyset,
      pepperKeyring: overlapNewActive,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const referencesAfterConvergence = Number(
      psql(
        fixture,
        currentPrimaryPod(fixture).metadata.name,
        `SELECT count(*)::integer FROM "ql3"."api_credentials" current_record WHERE credential_id = ${sqlString(
          oldCredential.credentialId,
        )} AND pepper_key_id = ${sqlString(
          oldPepperKeyId,
        )} AND version = (SELECT max(version) FROM "ql3"."api_credentials" WHERE credential_id = current_record.credential_id) AND state = 'active' AND expires_at_ms > (extract(epoch FROM statement_timestamp()) * 1000)::bigint`,
      ),
    );
    assert.equal(referencesAfterConvergence, 0);
    applyControlRuntimeSecret(fixture, runtimeDatabaseUrl, contractedNew);
    const controlAfterContraction = await waitForControlRollout(fixture, true);
    assert.equal(new Set(controlAfterContraction.nodes).size, 2);
    const oldAuthenticationAfterConvergence =
      await runCredentialAuthenticationProbe({
        fixture,
        adminImage,
        name: 'ql3-security-live-auth-old-contracted',
        deliveryFile: 'old-issue.json',
        expectedStatus: 401,
        requestId: authenticationRequestIds.oldAfterConvergence,
        createdEvidenceJobs,
      });
    const newAuthenticationAfterContraction =
      await runCredentialAuthenticationProbe({
        fixture,
        adminImage,
        name: 'ql3-security-live-auth-new-contracted',
        deliveryFile: 'new-rotate.json',
        expectedStatus: 403,
        requestId: authenticationRequestIds.newAfterContraction,
        createdEvidenceJobs,
      });
    const finalEvidence = await runCustodyEvidence({
      fixture,
      adminImage,
      name: 'ql3-security-live-evidence-final',
      expected: [
        { name: 'old-issue.json', operation: 'credential.issue' },
        { name: 'new-issue.json', operation: 'credential.issue' },
        { name: 'new-rotate.json', operation: 'credential.rotate' },
      ],
      kubernetesServiceIp,
      createdEvidenceJobs,
    });
    assert.equal(finalEvidence.files.length, 3);
    const issueFile = finalEvidence.files.find(
      (file) => file.name === 'old-issue.json',
    );
    const rotationFile = finalEvidence.files.find(
      (file) => file.name === 'new-rotate.json',
    );
    assert.ok(issueFile && rotationFile);
    assert.notEqual(issueFile.digest, rotationFile.digest);
    assert.deepEqual(issueFile, issuedEvidence.files[0]);

    const finalPrimary = currentPrimaryPod(fixture);
    const durable = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        [
          'SELECT json_build_object(',
          `  'identityVersion', (SELECT max(version)::integer FROM "ql3"."identity_subjects" WHERE subject_type = ${sqlString(
            values.subject.type,
          )} AND subject_id = ${sqlString(values.subject.id)}),`,
          `  'identityStatus', (SELECT status FROM "ql3"."identity_subjects" WHERE subject_type = ${sqlString(
            values.subject.type,
          )} AND subject_id = ${sqlString(values.subject.id)}),`,
          `  'oldCredentialVersion', (SELECT max(version)::integer FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            oldCredential.credentialId,
          )}),`,
          `  'oldCredentialState', (SELECT state FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            oldCredential.credentialId,
          )} ORDER BY version DESC LIMIT 1),`,
          `  'newCredentialVersion', (SELECT max(version)::integer FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            newCredential.credentialId,
          )}),`,
          `  'newCredentialState', (SELECT state FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            newCredential.credentialId,
          )} ORDER BY version DESC LIMIT 1),`,
          `  'identityMutationCount', (SELECT count(*)::integer FROM "ql3"."identity_subject_mutations" WHERE subject_type = ${sqlString(
            values.subject.type,
          )} AND subject_id = ${sqlString(values.subject.id)}),`,
          `  'credentialMutationCount', (SELECT count(*)::integer FROM "ql3"."api_credential_mutations" WHERE credential_id IN (${[
            oldCredential.credentialId,
            newCredential.credentialId,
          ].map(sqlString).join(',')})),`,
          `  'issueMutationCount', (SELECT count(*)::integer FROM "ql3"."api_credential_mutations" WHERE mutation_id = ${sqlString(
            oldCredential.issueMutationId,
          )}::uuid),`,
          `  'credentialVersionCount', (SELECT count(*)::integer FROM "ql3"."api_credentials" WHERE credential_id IN (${[
            oldCredential.credentialId,
            newCredential.credentialId,
          ].map(sqlString).join(',')})),`,
          `  'oldGenerationVersionCount', (SELECT count(*)::integer FROM "ql3"."api_credentials" WHERE credential_id IN (${[
            oldCredential.credentialId,
            newCredential.credentialId,
          ].map(sqlString).join(',')}) AND pepper_key_id = ${sqlString(oldPepperKeyId)}),`,
          `  'newGenerationVersionCount', (SELECT count(*)::integer FROM "ql3"."api_credentials" WHERE credential_id IN (${[
            oldCredential.credentialId,
            newCredential.credentialId,
          ].map(sqlString).join(',')}) AND pepper_key_id = ${sqlString(newPepperKeyId)}),`,
          `  'latestGenerationsAreNew', (SELECT count(*) = 2 FROM "ql3"."api_credentials" current_record WHERE credential_id IN (${[
            oldCredential.credentialId,
            newCredential.credentialId,
          ].map(sqlString).join(',')}) AND version = (SELECT max(version) FROM "ql3"."api_credentials" WHERE credential_id = current_record.credential_id) AND pepper_key_id = ${sqlString(newPepperKeyId)}),`,
          `  'allowedAuditCount', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE request_id IN (${[
            values.registerRequestId,
            oldCredential.issueRequestId,
            newCredential.issueRequestId,
            newCredential.rotateRequestId,
            oldCredential.revokeRequestId,
          ]
            .map(sqlString)
            .join(',')}) AND outcome = 'allowed'),`,
          `  'authenticationDeniedAuditCount', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE request_id IN (${[
            authenticationRequestIds.oldBeforeActivation,
            authenticationRequestIds.oldDuringOverlap,
            authenticationRequestIds.newDuringOverlap,
            authenticationRequestIds.newAfterContraction,
          ].map(sqlString).join(',')}) AND outcome = 'denied'),`,
          `  'authenticationRejectedAuditCount', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE request_id = ${sqlString(
            authenticationRequestIds.oldAfterConvergence,
          )} AND outcome = 'authentication_rejected'))`,
        ].join('\n'),
      ),
    );
    assert.deepEqual(durable, {
      identityVersion: 1,
      identityStatus: 'active',
      oldCredentialVersion: 2,
      oldCredentialState: 'revoked',
      newCredentialVersion: 2,
      newCredentialState: 'active',
      identityMutationCount: 1,
      credentialMutationCount: 4,
      issueMutationCount: 1,
      credentialVersionCount: 4,
      oldGenerationVersionCount: 1,
      newGenerationVersionCount: 3,
      latestGenerationsAreNew: true,
      allowedAuditCount: 5,
      authenticationDeniedAuditCount: 4,
      authenticationRejectedAuditCount: 1,
    });
    const adminRole = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        `SELECT json_build_object('login', rolcanlogin, 'superuser', rolsuper, 'createDatabase', rolcreatedb, 'createRole', rolcreaterole, 'replication', rolreplication, 'bypassRls', rolbypassrls, 'connectionLimit', rolconnlimit) FROM pg_roles WHERE rolname = 'ql3_admin'`,
      ),
    );
    assert.deepEqual(adminRole, {
      login: true,
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      connectionLimit: 4,
    });
    assert.equal(canI(fixture, 'get', 'secrets'), 'no');
    assert.equal(canI(fixture, 'create', 'jobs.batch'), 'no');

    const finalCluster = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'cluster',
      POSTGRES_CLUSTER,
    ]);
    const finalNodes = fixture.kubectlJson(['get', 'nodes']).items;
    const readyNodes = finalNodes.filter(
      (node) =>
        podReady(node) &&
        Array.isArray(node.spec.podCIDRs) &&
        node.spec.podCIDRs.length === 1,
    );
    assert.equal(readyNodes.length, 3);
    assert.equal(
      new Set(readyNodes.map((node) => node.spec.podCIDRs[0])).size,
      3,
    );
    const serverNode = readyNodes.find(
      (node) => node.metadata.name === fixture.server,
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/backend-type'
      ],
      'vxlan',
    );

    assert.equal(createdJobs.size, 0);
    assert.equal(createdSecrets.size, 0);
    assert.equal(createdEvidenceJobs.size, 0);
    deleteResource(fixture, `deployment/${CONTROL_NAME}`);
    deleteResource(fixture, `service/${CONTROL_NAME}`);
    deleteResource(fixture, `secret/${CONTROL_RUNTIME_SECRET}`);
    deleteResource(fixture, `persistentvolumeclaim/${DELIVERY_CLAIM}`);
    await waitFor('delivery PVC deletion', 60_000, () =>
      resourceAbsent(
        fixture,
        `persistentvolumeclaim/${DELIVERY_CLAIM}`,
      )
        ? { ready: true, value: true }
        : { ready: false, fact: 'PVC still exists' },
    );
    const cleanup = {
      jobsDeleted:
        resourceAbsent(fixture, 'job/ql3-security-live-register') &&
        resourceAbsent(fixture, 'job/ql3-security-live-revoke'),
      inputSecretsDeleted:
        resourceAbsent(
          fixture,
          'secret/ql3-security-live-register-input',
        ) &&
        resourceAbsent(
          fixture,
          'secret/ql3-security-live-revoke-input',
        ),
      evidenceJobsDeleted: resourceAbsent(
        fixture,
        'job/ql3-security-live-evidence-final',
      ),
      storageProvisionJobDeleted: resourceAbsent(
        fixture,
        'job/ql3-security-live-delivery-provision',
      ),
      deliveryVolumeClaimDeleted: resourceAbsent(
        fixture,
        `persistentvolumeclaim/${DELIVERY_CLAIM}`,
      ),
      controlDeploymentDeleted: resourceAbsent(
        fixture,
        `deployment/${CONTROL_NAME}`,
      ),
      controlServiceDeleted: resourceAbsent(
        fixture,
        `service/${CONTROL_NAME}`,
      ),
      controlRuntimeSecretDeleted: resourceAbsent(
        fixture,
        `secret/${CONTROL_RUNTIME_SECRET}`,
      ),
    };
    assert.equal(Object.values(cleanup).every(Boolean), true);

    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: {
        distribution: 'k3s',
        kubernetesVersion: nodes[0].status.nodeInfo.kubeletVersion,
        architecture,
        kubernetesImageId: imageIdDigest(k3sImageInfo),
        administrationImageId: imageIdDigest(adminImageInfo),
        controlImageId: imageIdDigest(controlImageInfo),
        cniName: 'flannel',
        cniDistributionBinding: fixture.k3sImage,
        controlPlaneNodes: 1,
        workerNodes: 2,
        readyNodes: readyNodes.length,
      },
      database: {
        operator: 'cloudnative-pg',
        operatorVersion: LOCK.operator.version,
        postgresVersionNumber: migrationState.postgresVersionNumber,
        postgresImageId: imageIdDigest(postgresImageInfo),
        instances: Number(finalCluster.spec.instances),
        readyInstances: Number(finalCluster.status.readyInstances),
        administrationRole: 'ql3_admin',
        roleConnectionLimit: adminRole.connectionLimit,
        commandConnectionLimit: 1,
        migrationCount: migrationState.migrationCount,
        controlCoreCapability: migrationState.controlCoreCapability,
        tlsVerified: true,
        leastPrivilege: true,
      },
      ceremony: {
        operations: [
          'identity.register',
          'audit.list',
          'credential.issue.old',
          'credential.issue.old.replay',
          'credential.key-references.before-activate',
          'credential.issue.new',
          'credential.rotate.new',
          'credential.key-references.after-activate',
          'credential.revoke.old',
          'credential.key-references.after-converge',
        ],
        completedJobs: 10,
        failedJobs: 1,
        authenticationProbeJobs: 5,
        controlReplicas: controlAfterContraction.replicas,
        controlRollouts: 3,
        controlReplicaAntiAffinity:
          new Set(controlBeforeActivation.nodes).size === 2 &&
          new Set(controlDuringOverlap.nodes).size === 2 &&
          new Set(controlAfterContraction.nodes).size === 2,
        callerDriven: true,
        backoffLimit: baseTemplate.spec.backoffLimit,
        activeDeadlineSeconds: baseTemplate.spec.activeDeadlineSeconds,
        ttlSecondsAfterFinished: baseTemplate.spec.ttlSecondsAfterFinished,
        serviceAccount: NAME,
        serviceAccountTokenMounted: false,
        rbacGranted: false,
        responseLossReplayObserved: true,
        overlapGenerationCount: overlapOldActive.keys.length,
        contractedGenerationCount: contractedNew.keys.length,
        activeGenerationChanged:
          overlapOldActive.activePepperKeyId !==
          overlapNewActive.activePepperKeyId,
        oldReferencesBeforeActivation: referencesBeforeActivate,
        oldReferencesAfterActivation: referencesAfterActivate,
        oldReferencesAfterConvergence: referencesAfterConvergence,
        oldAuthenticationBeforeActivation:
          oldAuthenticationBeforeActivation.observedStatus === 403,
        oldAuthenticationDuringOverlap:
          oldAuthenticationDuringOverlap.observedStatus === 403,
        newAuthenticationDuringOverlap:
          newAuthenticationDuringOverlap.observedStatus === 403,
        oldAuthenticationRejectedAfterConvergence:
          oldAuthenticationAfterConvergence.observedStatus === 401,
        newAuthenticationAfterContraction:
          newAuthenticationAfterContraction.observedStatus === 403,
        contractedToActiveGeneration:
          contractedNew.activePepperKeyId ===
            overlapNewActive.activePepperKeyId &&
          contractedNew.keys[0]?.pepperKeyId ===
            contractedNew.activePepperKeyId,
        sensitiveMaterialReported: false,
      },
      inputBoundary: {
        immutableSecret: true,
        projectedMode0440: true,
        memoryBackedPrivateStage: true,
        targetDirectoryMode0700: true,
        targetFilesMode0600: true,
        kubeletAtomicWriterProjectionAccepted: true,
        worldReadableProjectionRejected: true,
        mainContainerNotStartedAfterStageFailure: true,
      },
      deliveryCustody: {
        persistentVolumeClaim: true,
        accessMode: 'ReadWriteOnce',
        fixtureRootProvisioned: deliveryProvision.passed,
        fixtureRootMode: deliveryProvision.afterMode,
        fixtureProvisionerRanAsRoot: deliveryProvision.uid === 0,
        privateDirectoryMode: finalEvidence.directoryMode,
        fileMode: finalEvidence.fileMode,
        fileCount: finalEvidence.files.length,
        issueDigest: issueFile.digest,
        rotationDigest: rotationFile.digest,
        distinctRotationMaterial: issueFile.digest !== rotationFile.digest,
        persistentAcrossJobs: true,
        noReplaceReplayPreserved:
          JSON.stringify(replayEvidence.files) ===
          JSON.stringify(issuedEvidence.files),
        deliverySchemaValidated: true,
        bearerFormatValidatedInPod: true,
        sensitiveMaterialReported: false,
      },
      isolation: {
        dnsAndDatabaseEgressAllowed: finalEvidence.databaseConnected,
        kubernetesApiEgressDenied: !finalEvidence.kubernetesApiConnected,
        publicInternetEgressDenied: !finalEvidence.publicInternetConnected,
        secretReadRbacDenied: canI(fixture, 'get', 'secrets') === 'no',
        jobMutationRbacDenied: canI(fixture, 'create', 'jobs.batch') === 'no',
      },
      durability: durable,
      cleanup,
      gates: {
        realThreeNodeKubernetes: nodes.length === 3,
        realCloudNativePg:
          databasePods.length === 3 &&
          Number(finalCluster.status.readyInstances) === 3,
        realKubeletSecretProjection: true,
        realAdministrationProductCommands: true,
        realPersistentCredentialCustody: finalEvidence.files.length === 3,
        realClusterControlAuthenticationRotation:
          durable.authenticationDeniedAuditCount === 4 &&
          durable.authenticationRejectedAuditCount === 1,
        responseLossReplay: durable.issueMutationCount === 1,
        failedInputStageClosed: true,
        leastPrivilege: true,
        contentFreeEvidence: true,
        passed: true,
      },
      limitations: [...LIMITATIONS],
    };
    const audit = validateSecurityAdministrationKubernetesLiveReport(report);
    assert.deepEqual(audit.findings, []);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        fixture: FIXTURE,
        reportWritten: true,
        passed: true,
      })}\n`,
    );
  } finally {
    await fixture.cleanup();
    if (adminImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (controlImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', controlImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `QL3 Security Administration Kubernetes live contract failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  auditListCommand,
  clusterControlResources,
  runtimeFileMaterializationSource,
  controlRolloutFailureEvidence,
  controlTerminationFact,
  credentialAuthenticationProbeSource,
  credentialIssueCommand,
  credentialRevokeCommand,
  credentialRotateCommand,
  custodyEvidenceSource,
  deliveryVolumeProvisionSource,
  identity,
  identityRegisterCommand,
  inputAuthorityEvidenceSource,
  migrationFailureEvidence,
  networkPolicyReadinessSource,
};
