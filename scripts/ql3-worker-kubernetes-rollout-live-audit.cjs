#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = 'qinglong/worker-kubernetes-rollout-live-contract@v2';
const LIMITATIONS = Object.freeze([
  'single-node K3s local-path PVC is not multi-node CSI detach/attach evidence',
  'the product phase proves Session lifecycle but does not execute a Remote Run; the independent Worker PostgreSQL live gate owns Run execution evidence',
  'forced Pod deletion is not physical node power loss',
  'the live fixture uses deterministic local strong-User principals, not a production external IdP ceremony',
]);
const GATE_KEYS = Object.freeze([
  'realKubernetesApi',
  'secretAndDeploymentResourceVersionCas',
  'recreateOrderingObserved',
  'pvcJournalSurvivedRolloutAndForcedPodLoss',
  'explicitIdentityGenerationRolloutObserved',
  'strongUserPlanApprovalAndDispatchPersisted',
  'managerExecutorDatabaseRolesSeparated',
  'approvalConsumedBeforeTokenRequest',
  'leastPrivilegeTokenIssuerRbac',
  'tokenRequestSessionDisposed',
  'restrictedCredentialDeliveryRbac',
  'realCallerDrivenExecutorJob',
  'executorJobExactReplayWithoutTokenRequest',
  'executorJobUsesProjectedShortLivedIssuerToken',
  'executorJobExactNetworkEgress',
  'productionWorkerImageInKubernetes',
  'productionWorkerIngressComposition',
  'productionSessionReplacement',
  'productionStartupReconciliation',
  'productionGracefulDrainToOffline',
  'passed',
]);
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'certificate',
  'clientkey',
  'connectionstring',
  'dsn',
  'kubeconfig',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort());
}

function isInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function isSha256(value, prefix = false) {
  return typeof value === 'string' &&
    (prefix ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(value);
}

function isUuid(value) {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function isToken(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value);
}

function unique(value, count, predicate) {
  return Array.isArray(value) && value.length === count &&
    value.every(predicate) && new Set(value).size === count;
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return /-----BEGIN (?:CERTIFICATE|(?:RSA |EC |OPENSSH )?PRIVATE KEY)-----/.test(value) ||
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\bql3w_[A-Za-z0-9_-]{12,}\b/.test(value) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveMaterial(entry));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) =>
      containsSensitiveMaterial(child, childKey));
  }
  return false;
}

function validExecutorOutput(value, expectedDelivery, expectedTokenRequest) {
  return exactKeys(value, [
    'schemaVersion',
    'component',
    'event',
    'actionRef',
    'dispatchId',
    'executionStatus',
    'deliveryStatus',
    'tokenRequestUsed',
  ]) && value.schemaVersion === 1 &&
    value.component === 'qinglong3-worker-credential-executor' &&
    value.event === 'execution_completed' && isToken(value.actionRef) &&
    isToken(value.dispatchId) && value.executionStatus === 'succeeded' &&
    value.deliveryStatus === expectedDelivery &&
    value.tokenRequestUsed === expectedTokenRequest;
}

function validateWorkerKubernetesRolloutLiveReport(report) {
  const findings = [];
  if (!exactKeys(report, [
    'schemaVersion',
    'fixture',
    'observedAt',
    'sourceRevision',
    'kubernetes',
    'postgresql',
    'approvalExecution',
    'credentialRollout',
    'callerDrivenExecutorJob',
    'rbac',
    'recovery',
    'identityRollout',
    'productionWorker',
    'gates',
    'limitations',
  ]) || report?.schemaVersion !== 1 || report?.fixture !== FIXTURE ||
    typeof report?.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(report.observedAt)) ||
    !/^[a-f0-9]{40}$/.test(report?.sourceRevision ?? '')) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_REPORT_SHAPE',
      'the report must use the exact versioned envelope and source provenance',
    ));
  }

  if (containsSensitiveMaterial(report)) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_SECRET_EXPOSURE',
      'the report must not contain credentials, tokens, certificates, DSNs or private keys',
    ));
  }

  const kubernetes = report?.kubernetes;
  if (!exactKeys(kubernetes, [
    'distribution', 'image', 'imageDigest', 'architecture', 'serverVersion',
  ]) || kubernetes?.distribution !== 'k3s' ||
    kubernetes?.image !== 'rancher/k3s:v1.34.3-k3s1' ||
    !isSha256(kubernetes?.imageDigest, true) ||
    !['amd64', 'arm64'].includes(kubernetes?.architecture) ||
    !/^v1\.(?:3[2-9]|[4-9][0-9]|[1-9][0-9]{2,})\.[0-9]+/.test(
      kubernetes?.serverVersion ?? '',
    )) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_PLATFORM',
      'the report must bind the reviewed K3s image, digest, architecture and supported API version',
    ));
  }

  const postgres = report?.postgresql;
  if (!exactKeys(postgres, [
    'image', 'imageDigest', 'imageId', 'architecture', 'contractVersion',
    'migrationId', 'managerRole', 'executorRole',
  ]) || postgres?.image !== 'postgres:18.4-bookworm' ||
    postgres?.imageDigest !==
      'sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296' ||
    !isSha256(postgres?.imageId, true) ||
    !['amd64', 'arm64'].includes(postgres?.architecture) ||
    !isInteger(postgres?.contractVersion, 1) || !isToken(postgres?.migrationId) ||
    postgres?.managerRole !== 'ql3_worker_credential_manager' ||
    postgres?.executorRole !== 'ql3_worker_credential_executor') {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_DATABASE',
      'the report must prove the reviewed PostgreSQL image, current schema and separated roles',
    ));
  }

  const approval = report?.approvalExecution;
  if (!exactKeys(approval, [
    'plans', 'consumedApprovals', 'dispatches', 'succeededExecutions',
    'credentials', 'publishedDeliveries', 'auditEvents', 'planDigests',
    'approvalRequestIds', 'dispatchIds', 'hostAuthorizationRechecks',
    'tokenRequestAfterApprovalConsumption', 'executionReplayWithoutTokenRequest',
    'tokenOrSecretPersistedInPlan',
  ]) || approval?.plans !== 4 || approval?.consumedApprovals !== 4 ||
    approval?.dispatches !== 4 || approval?.succeededExecutions !== 4 ||
    approval?.credentials !== 4 || approval?.publishedDeliveries !== 4 ||
    approval?.auditEvents !== 16 ||
    !unique(approval?.planDigests, 4, (value) => isSha256(value)) ||
    !unique(approval?.approvalRequestIds, 4, (value) => isToken(value)) ||
    !unique(approval?.dispatchIds, 4, (value) => isToken(value)) ||
    approval?.hostAuthorizationRechecks !== 9 ||
    approval?.tokenRequestAfterApprovalConsumption !== true ||
    approval?.executionReplayWithoutTokenRequest !== true ||
    approval?.tokenOrSecretPersistedInPlan !== false) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_APPROVAL_EXECUTION',
      'four exact approved credential actions and their durable audit facts are required',
    ));
  }

  const credential = report?.credentialRollout;
  if (!exactKeys(credential, [
    'secretSeparatedFromTlsIdentity', 'generations', 'publicationDigests',
    'recreateStoppedOldBeforeStartingNew',
    'executorJobStoppedOldBeforeStartingNew',
  ]) || credential?.secretSeparatedFromTlsIdentity !== true ||
    !unique(credential?.generations, 4, (value) => isToken(value)) ||
    !unique(credential?.publicationDigests, 4, (value) => isSha256(value)) ||
    credential?.recreateStoppedOldBeforeStartingNew !== true ||
    credential?.executorJobStoppedOldBeforeStartingNew !== true) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_CREDENTIAL_ROLLOUT',
      'credential generations must be unique and both Recreate orderings must be observed',
    ));
  }

  const executor = report?.callerDrivenExecutorJob;
  if (!exactKeys(executor, [
    'image', 'firstJobName', 'firstPodUid', 'firstOutput', 'replayJobName',
    'replayPodUid', 'replayOutput', 'backoffLimit',
    'projectedIssuerTokenSeconds', 'apiServerEgressCidr',
    'apiServerBackendEgressCidr', 'apiServerBackendPort',
    'postgresEgressCidr',
  ]) || !isToken(executor?.image) || !isToken(executor?.firstJobName) ||
    !isUuid(executor?.firstPodUid) || !isToken(executor?.replayJobName) ||
    !isUuid(executor?.replayPodUid) ||
    executor?.firstPodUid === executor?.replayPodUid ||
    !validExecutorOutput(executor?.firstOutput, 'published', true) ||
    !validExecutorOutput(executor?.replayOutput, 'existing', false) ||
    executor?.backoffLimit !== 0 || executor?.projectedIssuerTokenSeconds !== 600 ||
    !/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(executor?.apiServerEgressCidr ?? '') ||
    !/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(executor?.apiServerBackendEgressCidr ?? '') ||
    executor?.apiServerBackendPort !== 6443 ||
    !/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(executor?.postgresEgressCidr ?? '')) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_EXECUTOR_JOB',
      'the caller-driven Job and exact replay must retain bounded token and egress authority',
    ));
  }

  const rbac = report?.rbac;
  if (!exactKeys(rbac, [
    'tokenIssuerImpersonatedUser', 'tokenIssuerExactServiceAccountBound',
    'hostTokenRequestSessions', 'executorJobTokenRequestSessions',
    'shortLivedTokenRequestSeconds', 'issuerAllowedChecks',
    'issuerDeniedChecks', 'serviceAccountAutomount',
    'workerPodServiceAccountTokenProjected', 'separateStageNamespace',
    'allowedChecks', 'deniedChecks', 'tokenNeverReturnedBySession',
    'restrictedClientDisposedAfterEachOperation', 'adapterUsedRestrictedToken',
  ]) || rbac?.tokenIssuerImpersonatedUser !==
      'ql3-worker-credential-operator-live' ||
    rbac?.tokenIssuerExactServiceAccountBound !== true ||
    rbac?.hostTokenRequestSessions !== 3 ||
    rbac?.executorJobTokenRequestSessions !== 1 ||
    rbac?.shortLivedTokenRequestSeconds !== 600 ||
    !isInteger(rbac?.issuerAllowedChecks, 1) ||
    !isInteger(rbac?.issuerDeniedChecks, 1) ||
    !isInteger(rbac?.allowedChecks, 1) || !isInteger(rbac?.deniedChecks, 1) ||
    rbac?.serviceAccountAutomount !== false ||
    rbac?.workerPodServiceAccountTokenProjected !== false ||
    rbac?.separateStageNamespace !== true ||
    rbac?.tokenNeverReturnedBySession !== true ||
    rbac?.restrictedClientDisposedAfterEachOperation !== true ||
    rbac?.adapterUsedRestrictedToken !== true) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_RBAC',
      'the issuer, executor and Worker must retain the exact least-privilege boundaries',
    ));
  }

  const recovery = report?.recovery;
  if (!exactKeys(recovery, [
    'pvcPhase', 'sameClaimAfterCredentialRollout',
    'sameClaimAfterForcedPodLoss', 'oldPodUid', 'rotatedPodUid',
    'crashReplacementPodUid', 'executorJobReplacementPodUid',
    'identityReplacementPodUid', 'durableJournalRecords',
  ]) || recovery?.pvcPhase !== 'Bound' ||
    recovery?.sameClaimAfterCredentialRollout !== true ||
    recovery?.sameClaimAfterForcedPodLoss !== true ||
    !unique([
      recovery?.oldPodUid, recovery?.rotatedPodUid,
      recovery?.crashReplacementPodUid, recovery?.executorJobReplacementPodUid,
      recovery?.identityReplacementPodUid,
    ], 5, isUuid) || !isInteger(recovery?.durableJournalRecords, 5)) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_RECOVERY',
      'one bound PVC and five distinct Pod identities with durable journal evidence are required',
    ));
  }

  const identity = report?.identityRollout;
  if (!exactKeys(identity, ['generation', 'caDigest', 'observedByReplacement']) ||
    identity?.generation !== 'product-identity-b' ||
    !isSha256(identity?.caDigest) ||
    identity?.observedByReplacement !== true) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_IDENTITY',
      'the identity-b projection and replacement observation must be digest bound',
    ));
  }

  const worker = report?.productionWorker;
  if (!exactKeys(worker, [
    'workerImageId', 'controlImageId', 'podUids', 'nodeNames', 'sessionIds',
    'generations', 'observationCount', 'gracefulDrainElapsedMs',
    'terminationGracePeriodSeconds', 'startupReconciliationBeforeOnline',
    'everySessionObservedOnlineDrainingOffline',
    'credentialRolloutCreatedFreshSession',
    'identityRolloutCreatedFreshSession', 'pvcReusedAcrossProductSessions',
    'serviceAccountTokenMounted', 'registerAudits', 'transitionAudits',
    'heartbeatAudits', 'credentialSecretsAbsent', 'fourthCredentialId',
  ]) || !isSha256(worker?.workerImageId, true) ||
    !isSha256(worker?.controlImageId, true) ||
    !unique(worker?.podUids, 3, isUuid) ||
    !Array.isArray(worker?.nodeNames) || worker.nodeNames.length !== 3 ||
    !worker.nodeNames.every((value) => isToken(value)) ||
    !unique(worker?.sessionIds, 3, isUuid) ||
    !Array.isArray(worker?.generations) || worker.generations.length !== 3 ||
    !worker.generations.every((value) => isInteger(value, 1)) ||
    !(worker.generations[0] < worker.generations[1] &&
      worker.generations[1] < worker.generations[2]) ||
    !isInteger(worker?.observationCount, 9) ||
    !isInteger(worker?.gracefulDrainElapsedMs, 0) ||
    worker?.gracefulDrainElapsedMs > 30_000 ||
    worker?.terminationGracePeriodSeconds !== 360 ||
    worker?.startupReconciliationBeforeOnline !== true ||
    worker?.everySessionObservedOnlineDrainingOffline !== true ||
    worker?.credentialRolloutCreatedFreshSession !== true ||
    worker?.identityRolloutCreatedFreshSession !== true ||
    worker?.pvcReusedAcrossProductSessions !== true ||
    worker?.serviceAccountTokenMounted !== false ||
    !isInteger(worker?.registerAudits, 3) ||
    !isInteger(worker?.transitionAudits, 6) ||
    !isInteger(worker?.heartbeatAudits, 3) ||
    worker?.credentialSecretsAbsent !== true ||
    worker?.fourthCredentialId !== 'live_generation_4') {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_PRODUCT_WORKER',
      'three production Worker Pods and Sessions must prove heartbeat, replacement and graceful drain durability',
    ));
  }

  if (!exactKeys(report?.gates, GATE_KEYS) ||
    !GATE_KEYS.every((key) => report.gates[key] === true)) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_GATES',
      'every independent Worker Kubernetes live gate must be explicitly true',
    ));
  }

  if (!Array.isArray(report?.limitations) ||
    JSON.stringify([...report.limitations].sort()) !==
      JSON.stringify([...LIMITATIONS].sort())) {
    findings.push(finding(
      'QL3_WORKER_KUBERNETES_LIVE_LIMITATIONS',
      'the disposable fixture limitations must remain explicit and exact',
    ));
  }

  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function readReport(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error('report path must be absolute');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 ||
    stat.size > 1024 * 1024 || (stat.mode & 0o022) !== 0) {
    throw new Error(
      'report must be a non-writable regular file between 2 bytes and 1 MiB',
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--report=')) {
    process.stderr.write(
      'usage: ql3-worker-kubernetes-rollout-live-audit --report=/absolute/report.json\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const result = validateWorkerKubernetesRolloutLiveReport(
        readReport(args[0].slice('--report='.length)),
      );
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.compatible) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(
        'Worker Kubernetes live audit failed: ' +
          (error instanceof Error ? error.message : String(error)) + '\n',
      );
      process.exitCode = 2;
    }
  }
}

module.exports = {
  FIXTURE,
  GATE_KEYS,
  LIMITATIONS,
  validateWorkerKubernetesRolloutLiveReport,
};
