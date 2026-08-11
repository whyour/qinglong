#!/usr/bin/env node

const fs = require('node:fs');

const {
  createPostgresDatabaseOpener,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  PostgresPluginPackageLifecyclePlanReader,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/packageManager.js');
const {
  createClusterPluginPackageLifecycleManagementService,
} = require('../packages/ql3-cluster-admin/dist/plugin-package/lifecycle/pluginPackageLifecycleManagement.js');
const {
  runClusterPluginPackageLifecycleExecution,
  runClusterPluginPackageLifecyclePlan,
} = require('../packages/ql3-cluster-admin/dist/plugin-package/lifecycle/pluginPackageLifecycleExecutor.js');

const PHASES = new Set(['plan', 'propose', 'decide', 'execute']);
const REQUESTER = Object.freeze({
  type: 'user',
  id: 'ha-lifecycle-owner',
});
const REVIEWER = Object.freeze({
  type: 'user',
  id: 'ha-lifecycle-reviewer',
});

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function databaseOpener(role, connectionString, applicationName) {
  return createPostgresDatabaseOpener({
    role,
    connection: {
      connectionString,
      tls: { mode: 'disable' },
    },
    pool: {
      applicationName,
      maxConnections: 2,
      connectionTimeoutMs: 2_000,
    },
    onPoolError() {},
  });
}

function identifiers(ordinal) {
  const suffix = String(ordinal).padStart(2, '0');
  return Object.freeze({
    approvalRequestId: `approval-managed-lifecycle-${ordinal}`,
    approvalAuditEventId:
      `34000000-0000-4000-8000-0000000001${suffix}`,
    decisionId: `decision-managed-lifecycle-${ordinal}`,
    decisionAuditEventId:
      `35000000-0000-4000-8000-0000000001${suffix}`,
    consumptionId: `consume-managed-lifecycle-${ordinal}`,
    dispatchId: `dispatch-managed-lifecycle-${ordinal}`,
    executionAuditEventId:
      `36000000-0000-4000-8000-0000000001${suffix}`,
  });
}

async function withDatabase(opener, callback) {
  const database = await opener();
  let failure;
  try {
    return await callback(database);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await database.close();
    } catch (closeError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, closeError],
          'lifecycle crash actor failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
}

async function loadPlan(managerOpener, actionRef) {
  return withDatabase(managerOpener, async (database) => {
    const plan = await new PostgresPluginPackageLifecyclePlanReader(
      database.pool,
    ).findByActionRef(actionRef);
    if (!plan) throw new Error('durable lifecycle plan is absent');
    return plan;
  });
}

function principal(subject, authenticationId, plan) {
  return Object.freeze({
    subject,
    authenticationId,
    authenticatedAtMs: plan.plannedAtMs,
    expiresAtMs: plan.expiresAtMs,
    assurance: 'multi_factor',
  });
}

async function runPhase(options) {
  const ids = identifiers(options.ordinal);
  const executorOpener = databaseOpener(
    'package-executor',
    options.executorUrl,
    `ql3-ha-lifecycle-crash-${options.action}-${options.phase}-executor`,
  );
  const managerOpener = databaseOpener(
    'package-manager',
    options.managerUrl,
    `ql3-ha-lifecycle-crash-${options.action}-${options.phase}-manager`,
  );
  if (options.phase === 'plan') {
    const result = await runClusterPluginPackageLifecyclePlan({
      openDatabase: executorOpener,
      actionRef: options.actionRef,
      action: options.action,
      projectId: options.projectId,
      packageName: options.packageName,
      requestedBy: REQUESTER,
      confirmAuthorization() {},
    });
    return Object.freeze({
      status: result.status,
      plan: result.plan,
    });
  }
  const plan = await loadPlan(managerOpener, options.actionRef);
  if (options.phase === 'propose') {
    return withDatabase(managerOpener, async (database) => {
      const service = createClusterPluginPackageLifecycleManagementService({
        pool: database.pool,
        now: () => plan.plannedAtMs + 1,
      });
      const result = await service.propose({
        actionRef: options.actionRef,
        approvalRequestId: ids.approvalRequestId,
        approvalAuditEventId: ids.approvalAuditEventId,
        principal: principal(
          REQUESTER,
          `managed-lifecycle-owner-auth-${options.ordinal}`,
          plan,
        ),
      });
      return Object.freeze({
        status: result.approvalStatus,
        approvalRequest: result.approvalRequest,
      });
    });
  }
  if (options.phase === 'decide') {
    return withDatabase(managerOpener, async (database) => {
      const service = createClusterPluginPackageLifecycleManagementService({
        pool: database.pool,
        now: () => plan.plannedAtMs + 2,
      });
      const result = await service.decide({
        actionRef: options.actionRef,
        approvalRequestId: ids.approvalRequestId,
        expectedVersion: 1,
        decisionId: ids.decisionId,
        auditEventId: ids.decisionAuditEventId,
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: principal(
          REVIEWER,
          `managed-lifecycle-reviewer-auth-${options.ordinal}`,
          plan,
        ),
      });
      return Object.freeze({
        status: result.status,
        approvalRequest: result.request,
      });
    });
  }
  const result = await runClusterPluginPackageLifecycleExecution({
    openDatabase: executorOpener,
    actionRef: options.actionRef,
    approvalRequestId: ids.approvalRequestId,
    consumptionId: ids.consumptionId,
    dispatchId: ids.dispatchId,
    auditEventId: ids.executionAuditEventId,
    confirmAuthorization() {},
  });
  return Object.freeze({
    status: result.status,
    receipt: result.receipt,
  });
}

function writeMarker(markerPath, options, status) {
  const descriptor = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      descriptor,
      JSON.stringify({
        schema:
          'qinglong/postgresql-plugin-package-lifecycle-process-crash@v1',
        action: options.action,
        phase: options.phase,
        status,
        pid: process.pid,
      }),
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main() {
  const phase = process.argv[2];
  if (!PHASES.has(phase)) {
    throw new Error('phase must be plan, propose, decide or execute');
  }
  const action = requiredEnvironment('QL3_LIFECYCLE_CRASH_ACTION');
  if (action !== 'disable' && action !== 'enable') {
    throw new Error('QL3_LIFECYCLE_CRASH_ACTION is invalid');
  }
  const options = Object.freeze({
    phase,
    action,
    ordinal: positiveInteger(
      requiredEnvironment('QL3_LIFECYCLE_CRASH_ORDINAL'),
      'QL3_LIFECYCLE_CRASH_ORDINAL',
    ),
    actionRef: requiredEnvironment('QL3_LIFECYCLE_CRASH_ACTION_REF'),
    projectId: requiredEnvironment('QL3_LIFECYCLE_CRASH_PROJECT_ID'),
    packageName: requiredEnvironment('QL3_LIFECYCLE_CRASH_PACKAGE_NAME'),
    managerUrl: requiredEnvironment('QL3_LIFECYCLE_CRASH_MANAGER_URL'),
    executorUrl: requiredEnvironment('QL3_LIFECYCLE_CRASH_EXECUTOR_URL'),
  });
  const result = await runPhase(options);
  if (process.env.QL3_LIFECYCLE_CRASH_KILL_AFTER_DURABLE === 'true') {
    const markerPath = requiredEnvironment(
      'QL3_LIFECYCLE_CRASH_MARKER_PATH',
    );
    writeMarker(markerPath, options, result.status);
    process.kill(process.pid, 'SIGKILL');
    throw new Error('SIGKILL did not terminate lifecycle crash actor');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `ql3 lifecycle crash actor failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
