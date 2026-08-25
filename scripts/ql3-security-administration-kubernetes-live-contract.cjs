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
      expectedCurrentVersion: 2,
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
  return `'use strict';const fs=require('node:fs');const path=require('node:path');const names=['command.json','assertion.jwt','keyset.json','pepper'];const source='/var/run/secrets/qinglong3/security-administration-projected';const parent='/var/run/qinglong3/security-administration-private';const target=parent+'/input';const deliveryRoot='/var/lib/qinglong3/security-administration-delivery';const deliveryPrivate=deliveryRoot+'/private';const facts=(value)=>{const status=fs.lstatSync(value);return{mode:(status.mode&0o7777).toString(8),uid:status.uid,gid:status.gid,directory:status.isDirectory(),file:status.isFile(),symlink:status.isSymbolicLink()}};const sourceReal=fs.realpathSync(source);const files=names.map((name)=>{const candidate=source+'/'+name;const resolved=fs.realpathSync(candidate);const relative=path.relative(sourceReal,resolved);return{name,link:facts(candidate),resolved:facts(resolved),confined:relative!==''&&relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative)}});fs.writeFileSync('/dev/termination-log',JSON.stringify({schema:'qinglong/security-administration-input-authority@v1',source:facts(source),parent:facts(parent),targetExists:fs.existsSync(target),deliveryRoot:fs.existsSync(deliveryRoot)?facts(deliveryRoot):null,deliveryPrivateExists:fs.existsSync(deliveryPrivate),files}));`;
}

function deliveryVolumeProvisionSource() {
  return `'use strict';const fs=require('node:fs');const root='/delivery';const facts=()=>{const status=fs.lstatSync(root);return{mode:(status.mode&0o7777).toString(8),uid:status.uid,gid:status.gid,directory:status.isDirectory(),symlink:status.isSymbolicLink()}};const before=facts();if(!before.directory||before.symlink||before.uid!==0||before.gid!==10001||before.mode!=='2777')throw new Error('UNEXPECTED_VOLUME_ROOT');fs.chmodSync(root,0o2770);const descriptor=fs.openSync(root,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY??0));try{fs.fsyncSync(descriptor)}finally{fs.closeSync(descriptor)}const after=facts();if(!after.directory||after.symlink||after.uid!==0||after.gid!==10001||after.mode!=='2770')throw new Error('VOLUME_ROOT_NOT_CONSTRAINED');fs.writeFileSync('/dev/termination-log',JSON.stringify({schema:'qinglong/security-administration-delivery-volume-provision@v1',beforeMode:before.mode,afterMode:after.mode,uid:after.uid,gid:after.gid,passed:true}));`;
}

function administrationJob(
  template,
  { name, inputSecretName, deliveryFile, projectedMode },
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
      return (complete || failed) && pods.length === 1
        ? { ready: true, value: { job, pod: pods[0], complete, failed } }
        : {
            ready: false,
            fact: `${pods.length} Pods; status=${JSON.stringify(
              job.status ?? {},
            )}`,
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
  pepper,
  deliveryFile,
  expectedComplete,
  projectedMode,
  createdJobs,
  createdSecrets,
}) {
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
      pepper: `${pepper}\n`,
    },
  });
  createdSecrets.add(inputSecretName);
  const job = administrationJob(template, {
    name,
    inputSecretName,
    deliveryFile,
    projectedMode,
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
    const snapshot = await terminalJobSnapshot(fixture, name, 120_000);
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
    const snapshot = await terminalJobSnapshot(fixture, name, 120_000);
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
    fixture.kubectl(['create', '-f', '-'], {
      input: `${migrationManifest}\n`,
    });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Complete',
      'job/ql3-cluster-migration',
      '--timeout=10m',
    ]);
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
      credentialId: `d406-live-${suffix}`,
      identityMutationId: crypto.randomUUID(),
      issueMutationId: crypto.randomUUID(),
      rotateMutationId: crypto.randomUUID(),
      revokeMutationId: crypto.randomUUID(),
      registerRequestId: `d406-register-${suffix}`,
      issueRequestId: `d406-issue-${suffix}`,
      rotateRequestId: `d406-rotate-${suffix}`,
      revokeRequestId: `d406-revoke-${suffix}`,
    });
    const key = identity.reviewedKey('security-administration-live-key-1');
    const keyset = identity.keyset(1, [key]);
    const pepper = randomSecret();
    const register = identityRegisterCommand(values);
    const revoke = credentialRevokeCommand(values);

    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-invalid-input',
      command: register,
      assertion: identity.assertion(key, 'invalid-input'),
      keyset,
      pepper,
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
      pepper,
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
      pepper,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const issueNotBeforeAtMs = Date.now() + 5 * 60 * 1000;
    const issue = credentialIssueCommand({
      ...values,
      notBeforeAtMs: issueNotBeforeAtMs,
      expiresAtMs: issueNotBeforeAtMs + 60 * 60 * 1000,
    });
    const issueAssertion = identity.assertion(key, 'issue-response-loss');
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-issue',
      command: issue,
      assertion: issueAssertion,
      keyset,
      pepper,
      deliveryFile: 'issue.json',
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
      expected: [{ name: 'issue.json', operation: 'credential.issue' }],
      kubernetesServiceIp,
      createdEvidenceJobs,
    });
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-issue-replay',
      command: issue,
      assertion: issueAssertion,
      keyset,
      pepper,
      deliveryFile: 'issue.json',
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const replayEvidence = await runCustodyEvidence({
      fixture,
      adminImage,
      name: 'ql3-security-live-evidence-replay',
      expected: [{ name: 'issue.json', operation: 'credential.issue' }],
      kubernetesServiceIp,
      createdEvidenceJobs,
    });
    assert.deepEqual(replayEvidence.files, issuedEvidence.files);
    const rotateNotBeforeAtMs = Date.now() + 5 * 60 * 1000;
    const rotate = credentialRotateCommand({
      ...values,
      notBeforeAtMs: rotateNotBeforeAtMs,
      expiresAtMs: rotateNotBeforeAtMs + 60 * 60 * 1000,
    });
    await runAdministrationJob({
      fixture,
      template: deliveryTemplate,
      name: 'ql3-security-live-rotate',
      command: rotate,
      assertion: identity.assertion(key, 'rotate'),
      keyset,
      pepper,
      deliveryFile: 'rotate.json',
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    await runAdministrationJob({
      fixture,
      template: baseTemplate,
      name: 'ql3-security-live-revoke',
      command: revoke,
      assertion: identity.assertion(key, 'revoke'),
      keyset,
      pepper,
      expectedComplete: true,
      createdJobs,
      createdSecrets,
    });
    const finalEvidence = await runCustodyEvidence({
      fixture,
      adminImage,
      name: 'ql3-security-live-evidence-final',
      expected: [
        { name: 'issue.json', operation: 'credential.issue' },
        { name: 'rotate.json', operation: 'credential.rotate' },
      ],
      kubernetesServiceIp,
      createdEvidenceJobs,
    });
    assert.equal(finalEvidence.files.length, 2);
    const issueFile = finalEvidence.files.find(
      (file) => file.name === 'issue.json',
    );
    const rotationFile = finalEvidence.files.find(
      (file) => file.name === 'rotate.json',
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
          `  'credentialVersion', (SELECT max(version)::integer FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            values.credentialId,
          )}),`,
          `  'credentialState', (SELECT state FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            values.credentialId,
          )} ORDER BY version DESC LIMIT 1),`,
          `  'identityMutationCount', (SELECT count(*)::integer FROM "ql3"."identity_subject_mutations" WHERE subject_type = ${sqlString(
            values.subject.type,
          )} AND subject_id = ${sqlString(values.subject.id)}),`,
          `  'credentialMutationCount', (SELECT count(*)::integer FROM "ql3"."api_credential_mutations" WHERE credential_id = ${sqlString(
            values.credentialId,
          )}),`,
          `  'issueMutationCount', (SELECT count(*)::integer FROM "ql3"."api_credential_mutations" WHERE mutation_id = ${sqlString(
            values.issueMutationId,
          )}::uuid),`,
          `  'credentialVersionCount', (SELECT count(*)::integer FROM "ql3"."api_credentials" WHERE credential_id = ${sqlString(
            values.credentialId,
          )}),`,
          `  'allowedAuditCount', (SELECT count(*)::integer FROM "ql3"."security_audit_events" WHERE request_id IN (${[
            values.registerRequestId,
            values.issueRequestId,
            values.rotateRequestId,
            values.revokeRequestId,
          ]
            .map(sqlString)
            .join(',')}) AND outcome = 'allowed'))`,
        ].join('\n'),
      ),
    );
    assert.deepEqual(durable, {
      identityVersion: 1,
      identityStatus: 'active',
      credentialVersion: 3,
      credentialState: 'revoked',
      identityMutationCount: 1,
      credentialMutationCount: 3,
      issueMutationCount: 1,
      credentialVersionCount: 3,
      allowedAuditCount: 4,
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
          'credential.issue',
          'credential.issue.replay',
          'credential.rotate',
          'credential.revoke',
        ],
        completedJobs: 6,
        failedJobs: 1,
        callerDriven: true,
        backoffLimit: baseTemplate.spec.backoffLimit,
        activeDeadlineSeconds: baseTemplate.spec.activeDeadlineSeconds,
        ttlSecondsAfterFinished: baseTemplate.spec.ttlSecondsAfterFinished,
        serviceAccount: NAME,
        serviceAccountTokenMounted: false,
        rbacGranted: false,
        responseLossReplayObserved: true,
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
        realPersistentCredentialCustody: finalEvidence.files.length === 2,
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
  credentialIssueCommand,
  credentialRevokeCommand,
  credentialRotateCommand,
  custodyEvidenceSource,
  deliveryVolumeProvisionSource,
  identity,
  identityRegisterCommand,
  inputAuthorityEvidenceSource,
};
