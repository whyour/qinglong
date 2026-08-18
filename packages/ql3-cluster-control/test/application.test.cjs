const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { test } = require('node:test');
const {
  startClusterControlApplication,
} = require('@qinglong/cluster-control/application');
const {
  ClusterControlAvailabilityFence,
} = require('@qinglong/cluster-control/availability');
const {
  apiCredentialSecretDigest,
} = require('@qinglong/cluster-control/api-credential');
const {
  createClusterControlAdmissionPipeline,
  createClusterControlProjectPolicyAuthorizer,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');
const {
  PostgresSchemaReadinessError,
  postgresqlMainMigrationManifest,
} = require('@qinglong/cluster-postgres/runtime');
const {
  postgresqlControlSchemaContract,
} = require('@qinglong/cluster-postgres');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(port, path, options = {}) {
  const body =
    options.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          connection: 'close',
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': String(body.byteLength),
              }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode,
            body: text.length === 0 ? null : JSON.parse(text),
          });
        });
      },
    );
    outgoing.once('error', reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function migrationHistory() {
  return postgresqlMainMigrationManifest.migrations.map((migration, index) => ({
    streamId: postgresqlMainMigrationManifest.id,
    dialect: postgresqlMainMigrationManifest.dialect,
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
}

function admission(handler) {
  return {
    async prepare(metadata) {
      return {
        handle(body) {
          return handler({ ...metadata, body });
        },
      };
    },
  };
}

function runtimePrivileges() {
  const privileges = {
    schema_migrations: [true, false, false, false],
    schema_capabilities: [true, false, false, false],
    projects: [true, true, true, false],
    task_definitions: [true, false, false, false],
    task_definition_revisions: [true, false, false, false],
    task_execution_revisions: [true, false, false, false],
    triggers: [true, false, false, false],
    trigger_revisions: [true, false, false, false],
    trigger_schedules: [true, false, true, false],
    project_role_bindings: [true, true, false, false],
    identity_subjects: [true, false, false, false],
    api_credentials: [true, false, false, false],
    security_audit_events: [false, true, false, false],
    identity_subject_mutations: [false, false, false, false],
    api_credential_mutations: [false, false, false, false],
    runs: [true, true, true, false],
    step_runs: [true, true, true, false],
    step_run_mutations: [true, true, false, false],
    tool_execution_trace_anchors: [true, true, false, false],
    tool_execution_audit_receipts: [true, true, false, false],
    tool_execution_start_barriers: [true, true, false, false],
    tool_execution_start_artifact_bindings: [true, true, false, false],
    tool_execution_completions: [true, true, false, false],
    tool_execution_failure_completions: [true, true, false, false],
    tool_result_key_catalog_generations: [true, false, false, false],
    tool_execution_result_key_bindings: [true, true, false, false],
    tool_execution_result_rekey_overlays: [true, false, false, false],
    tool_execution_result_rekey_heads: [true, false, false, false],
    tool_result_key_retirement_receipts: [false, false, false, false],
    tool_invocation_input_artifacts: [true, true, false, false],
    tool_invocation_preview_artifacts: [true, true, false, false],
    run_attempts: [true, true, true, false],
    run_attempt_log_retention_controls: [true, true, true, true],
    run_attempt_log_artifact_tombstones: [true, true, false, false],
    run_recovery_controls: [true, true, true, false],
    worker_sessions: [true, true, true, false],
    run_dispatch_leases: [true, true, true, false],
    worker_credentials: [false, false, false, false],
    worker_credential_mutations: [false, false, false, false],
    worker_credential_deliveries: [false, false, false, false],
    worker_credential_stage_discards: [false, false, false, false],
    worker_credential_management_plans: [false, false, false, false],
    worker_credential_management_quota_buckets: [false, false, false, false],
    plugin_package_installs: [false, false, false, false],
    plugin_package_install_heads: [false, false, false, false],
    plugin_package_install_mutations: [false, false, false, false],
    approval_requests: [false, false, false, false],
    approved_action_dispatches: [false, false, false, false],
    approved_action_executions: [false, false, false, false],
    approved_action_manual_recovery_resolutions: [false, false, false, false],
    plugin_package_install_proposals: [false, false, false, false],
    plugin_package_admission_receipts: [false, false, false, false],
    plugin_package_management_quota_buckets: [false, false, false, false],
    plugin_package_identity_keyset_ledger: [false, false, false, false],
    plugin_package_materialized_revisions: [false, false, false, false],
    plugin_package_task_ownerships: [false, false, false, false],
    plugin_package_task_reconciliations: [false, false, false, false],
    plugin_package_task_reconciliation_items: [false, false, false, false],
    project_tool_definition_snapshots: [false, false, false, false],
    project_tool_definition_snapshot_sources: [false, false, false, false],
    plugin_package_publisher_provenance: [false, false, false, false],
    plugin_package_publisher_revocation_impact_items: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_revocation_impacts: [false, false, false, false],
    plugin_package_publisher_revocation_proposals: [false, false, false, false],
    plugin_package_publisher_revocation_receipts: [false, false, false, false],
    plugin_package_publisher_trust_heads: [false, false, false, false],
    plugin_package_publisher_trust_snapshots: [false, false, false, false],
    plugin_package_publisher_trust_transition_proposals: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_trust_transition_receipts: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_quarantine_events: [false, false, false, false],
    plugin_package_withdrawal_receipts: [false, false, false, false],
    plugin_package_withdrawal_tasks: [false, false, false, false],
    plugin_package_lifecycle_events: [false, false, false, false],
    plugin_package_lifecycle_heads: [false, false, false, false],
    plugin_package_lifecycle_receipts: [false, false, false, false],
    plugin_package_lifecycle_tasks: [false, false, false, false],
    plugin_package_lifecycle_plans: [false, false, false, false],
    plugin_package_automation_publications: [true, false, false, false],
    plugin_package_automation_disposition_events: [false, false, false, false],
    plugin_package_automation_publication_heads: [true, false, false, false],
    plugin_package_secret_binding_approval_plans: [false, false, false, false],
    plugin_package_secret_binding_transition_approval_plans: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_secret_bindings: [false, false, false, false],
    plugin_package_secret_binding_transition_receipts: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_workflow_admissions: [true, true, false, false],
    plugin_package_workflow_admission_steps: [true, true, false, false],
    plugin_package_workflow_task_attempt_admissions: [true, true, false, false],
    worker_execution_attestations: [true, false, false, false],
    run_events: [true, true, false, false],
    run_cancellation_dispatches: [true, true, true, false],
    run_retry_policies: [true, true, true, false],
  };
  return Object.entries(privileges).map(
    ([
      tableName,
      [selectAllowed, insertAllowed, updateAllowed, deleteAllowed],
    ]) => ({
      tableName,
      selectAllowed,
      insertAllowed,
      updateAllowed,
      deleteAllowed,
      isOwner: false,
    }),
  );
}

function databaseResource(events, options = {}) {
  const contract = postgresqlControlSchemaContract;
  let firstQuery = true;
  const pool = {
    async query(text, values) {
      events.push('query');
      if (firstQuery && options.readinessGate) {
        firstQuery = false;
        options.onReadinessQuery?.();
        await options.readinessGate;
      }
      if (text.includes("current_setting('server_version_num')")) {
        return {
          rows: [
            {
              serverVersionNum: options.serverVersionNum ?? '160014',
              currentUser: 'ql3_runtime',
              inRecovery: false,
              transactionReadOnly: 'off',
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."schema_migrations"')) {
        return { rows: migrationHistory() };
      }
      if (text.includes('FROM "ql3"."schema_capabilities"')) {
        return {
          rows: [
            {
              contractName: contract.contractName,
              contractVersion: contract.contractVersion,
              migrationId: contract.migrationId,
              capabilities: contract.capabilities,
            },
          ],
        };
      }
      if (text.includes('FROM pg_class tables')) {
        return {
          rows: contract.tables.flatMap((table) =>
            table.columns.map((columnName) => ({
              tableName: table.name,
              columnName,
            })),
          ),
        };
      }
      if (text.includes('FROM pg_indexes')) {
        return { rows: contract.indexes.map((indexName) => ({ indexName })) };
      }
      if (text.includes('FROM pg_constraint')) {
        return {
          rows: [
            ...contract.checks.map((constraintName) => ({
              constraintName,
              constraintType: 'check',
            })),
            ...contract.foreignKeys.map((constraintName) => ({
              constraintName,
              constraintType: 'foreign_key',
            })),
          ],
        };
      }
      if (text.includes('FROM pg_proc routines')) {
        return {
          rows: contract.functions.map((definition) => ({
            functionName: definition.name,
            identityArguments: definition.identityArguments,
            owner: definition.owner,
            securityDefiner: definition.securityDefiner,
            volatility: definition.volatility,
            configuration: definition.configuration,
            publicExecute: false,
          })),
        };
      }
      if (text.includes('FROM pg_trigger triggers')) {
        return {
          rows: contract.triggers.map((definition) => ({
            triggerName: definition.name,
            tableName: definition.tableName,
            functionName: definition.functionName,
            enabled: 'O',
          })),
        };
      }
      if (text.includes('FROM pg_catalog.pg_roles')) {
        return {
          rows: [
            {
              canLogin: true,
              superuser: false,
              createDatabase: false,
              createRole: false,
              replication: false,
              bypassRowLevelSecurity: false,
              databaseConnect: true,
            },
          ],
        };
      }
      if (text.includes('has_schema_privilege')) {
        return { rows: [{ schemaUsage: true, schemaCreate: false }] };
      }
      if (text.includes('has_table_privilege')) {
        return { rows: runtimePrivileges() };
      }
      if (text.includes('has_function_privilege')) {
        return {
          rows: contract.functions.map(({ name: functionName }) => ({
            functionName,
            executeAllowed: [
              'plugin_package_automation_start_allowed',
              'plugin_package_workflow_admission_snapshot',
              'plugin_package_workflow_task_attempt_snapshot',
              'plugin_package_run_start_allowed',
              'plugin_package_tool_start_allowed',
              'lock_run_management_policy_fence',
            ].includes(functionName),
            isOwner: false,
          })),
        };
      }
      if (text.includes('WITH observation AS')) {
        return {
          rows: options.recoveryRows ?? [
            {
              observedAtMs: '1',
              kind: null,
              id: null,
              runId: null,
              status: null,
              createdAtMs: null,
            },
          ],
        };
      }
      if (options.query) return options.query(text, values);
      throw new Error(`unexpected query: ${text}`);
    },
    async connect() {
      throw new Error('Repository connections are not used by this fixture');
    },
  };
  return {
    pool,
    async close() {
      events.push('close-database');
    },
  };
}

function baseOptions(events, port, overrides = {}) {
  return {
    enabled: true,
    profile: 'cluster-control',
    apiCredentialPepper: 'A'.repeat(43),
    recovery: { ownerId: 'test-replica', providers: [] },
    availability: new ClusterControlAvailabilityFence(),
    http: { host: '127.0.0.1', port, drainTimeoutMs: 1000 },
    async openDatabase() {
      events.push('open-database');
      return databaseResource(events);
    },
    create({
      evidence,
      authenticator,
      policies,
      runs,
      taskDefinitions,
      taskExecutionRevisions,
      triggers,
      schedules,
      securityAudit,
    }) {
      events.push('create-stack');
      assert.equal(
        evidence.contractVersion,
        postgresqlControlSchemaContract.contractVersion,
      );
      assert.equal(typeof authenticator.authenticate, 'function');
      assert.equal(typeof policies.resolve, 'function');
      assert.equal(typeof runs.transaction, 'function');
      assert.equal(
        typeof taskDefinitions.findCurrentTaskDefinition,
        'function',
      );
      assert.equal(
        typeof taskExecutionRevisions.resolveClusterTaskExecutionRevision,
        'function',
      );
      assert.equal(typeof triggers.findCurrentTrigger, 'function');
      assert.equal(typeof schedules.claimNextClusterSchedule, 'function');
      assert.equal(typeof schedules.commitClusterScheduleDecision, 'function');
      assert.equal(typeof securityAudit.record, 'function');
      return {
        async reconcile() {
          events.push('reconcile');
          return { safe: true, remaining: 0, failed: 0 };
        },
        async startLifecycles() {
          events.push('start-lifecycles');
          return true;
        },
        admission: admission(async (incoming) => {
          events.push(`handle:${incoming.path}`);
          return { statusCode: 202, body: { accepted: true } };
        }),
        async stop() {
          events.push('stop-stack');
          return 'stopped';
        },
      };
    },
    audit(record) {
      events.push(`audit:${record.state}`);
    },
    ...overrides,
  };
}

test('disabled and wrong-profile applications never bind or open PostgreSQL', async () => {
  const disabledEvents = [];
  const disabled = await startClusterControlApplication(
    baseOptions(disabledEvents, 0, { enabled: false }),
  );
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabledEvents, ['audit:disabled']);

  const wrongProfileEvents = [];
  await assert.rejects(
    startClusterControlApplication(
      baseOptions(wrongProfileEvents, 0, { profile: 'standalone' }),
    ),
    /cannot activate cluster-control/,
  );
  assert.deepEqual(wrongProfileEvents, []);
});

test('rejects an invalid credential pepper before binding or opening PostgreSQL', async () => {
  const events = [];
  await assert.rejects(
    startClusterControlApplication(
      baseOptions(events, 0, { apiCredentialPepper: undefined }),
    ),
    /API credential configuration is invalid/,
  );
  assert.deepEqual(events, []);
});

test('rejects an enabled application without an availability source', async () => {
  const events = [];
  await assert.rejects(
    startClusterControlApplication(
      baseOptions(events, 0, { availability: undefined }),
    ),
    /availability source is invalid/,
  );
  assert.deepEqual(events, []);
});

test('composes bearer authentication, fenced Policy and durable audit on one Pool', async (t) => {
  const pepper = 'A'.repeat(43);
  const secret = Buffer.alloc(32, 2).toString('base64url');
  const digest = apiCredentialSecretDigest(pepper, 'app_primary', secret);
  const auditWrites = [];
  const events = [];
  const port = await freePort();
  const result = await startClusterControlApplication(
    baseOptions(events, port, {
      apiCredentialPepper: pepper,
      async openDatabase() {
        events.push('open-database');
        return databaseResource(events, {
          async query(text, values) {
            if (text.includes('FROM "ql3"."api_credentials"')) {
              return {
                rows: [
                  {
                    credentialId: 'app_primary',
                    version: '1',
                    state: 'active',
                    subjectType: 'api_app',
                    subjectId: 'app_primary',
                    subjectStatus: 'active',
                    pepperKeyId: 'legacy-v1',
                    secretDigest: digest,
                    createdAtMs: '1',
                    notBeforeAtMs: '1',
                    expiresAtMs: String(Date.now() + 60_000),
                  },
                ],
              };
            }
            if (text.includes('FROM "ql3"."projects" AS project')) {
              return {
                rows: [
                  {
                    projectId: 'default',
                    projectName: 'Default',
                    projectSlug: 'default',
                    projectStatus: 'active',
                    projectVersion: '2',
                    projectCreatedAtMs: '0',
                    projectUpdatedAtMs: '1',
                    bindingProjectId: 'default',
                    bindingSubjectType: 'api_app',
                    bindingSubjectId: 'app_primary',
                    bindingVersion: '3',
                    bindingState: 'active',
                    bindingRole: 'operator',
                    bindingMutationId: 'grant-app',
                    bindingChangedByType: 'user',
                    bindingChangedById: 'usr_owner',
                    bindingCreatedAtMs: '1',
                  },
                ],
              };
            }
            if (text.startsWith('INSERT INTO "ql3"."security_audit_events"')) {
              auditWrites.push(values);
              return { rows: [] };
            }
            throw new Error(`unexpected repository query: ${text}`);
          },
        });
      },
      create({ authenticator, policies, securityAudit }) {
        events.push('create-stack');
        return {
          async reconcile() {
            return { safe: true, remaining: 0, failed: 0 };
          },
          async startLifecycles() {
            return true;
          },
          admission: createClusterControlAdmissionPipeline({
            routes: createClusterControlRouteRegistry([
              {
                method: 'POST',
                path: '/api/v3/projects/{projectId}/runs',
                operationId: 'run.create',
                permission: 'run.start',
                projectParameter: 'projectId',
                handle(input) {
                  return {
                    statusCode: 202,
                    body: {
                      accepted: true,
                      subject: input.principal.subject.id,
                    },
                  };
                },
              },
            ]),
            authenticator,
            policy: createClusterControlProjectPolicyAuthorizer(policies),
            audit: securityAudit,
          }),
          async stop() {
            return 'stopped';
          },
        };
      },
    }),
  );
  t.after(() => result.stop());

  const rejected = await request(port, '/api/v3/projects/default/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(1024 * 1024),
    },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0][7], 'authentication_rejected');

  const accepted = await request(port, '/api/v3/projects/default/runs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ql3c_app_primary_${secret}`,
    },
    body: { taskId: 'task-1' },
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.body, {
    accepted: true,
    subject: 'app_primary',
  });
  assert.equal(auditWrites.length, 2);
  assert.equal(auditWrites[1][7], 'allowed');
  assert.equal(auditWrites[1][9], 2);
  assert.equal(auditWrites[1][10], 3);
  assert.equal(JSON.stringify(auditWrites).includes(secret), false);
});

test('serves not-ready while auditing PostgreSQL, then opens admission', async () => {
  const events = [];
  const port = await freePort();
  let releaseReadiness;
  const readinessGate = new Promise((resolve) => {
    releaseReadiness = resolve;
  });
  let readinessStarted;
  const readinessStartedPromise = new Promise((resolve) => {
    readinessStarted = resolve;
  });
  const starting = startClusterControlApplication(
    baseOptions(events, port, {
      async openDatabase() {
        events.push('open-database');
        return databaseResource(events, {
          readinessGate,
          onReadinessQuery: readinessStarted,
        });
      },
    }),
  );
  await readinessStartedPromise;
  assert.equal((await request(port, '/livez')).statusCode, 200);
  assert.deepEqual(await request(port, '/readyz'), {
    statusCode: 503,
    body: { status: 'not_ready' },
  });
  assert.equal(events.includes('create-stack'), false);

  releaseReadiness();
  const application = await starting;
  assert.equal(application.status, 'active');
  assert.deepEqual(await request(port, '/readyz'), {
    statusCode: 200,
    body: { status: 'ready' },
  });
  assert.deepEqual(
    await request(port, '/api/v3/runs', {
      method: 'POST',
      body: { taskId: 'task-1' },
    }),
    { statusCode: 202, body: { accepted: true } },
  );
  assert.equal(await application.stop(), 'stopped');
  assert.deepEqual(events.slice(-3), [
    'stop-stack',
    'audit:stopped',
    'close-database',
  ]);
  await assert.rejects(request(port, '/livez'));
});

test('withdraws and drains application admission before stack and Pool stop', async () => {
  const events = [];
  const port = await freePort();
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const handlerGate = new Promise((resolve) => {
    release = resolve;
  });
  const application = await startClusterControlApplication(
    baseOptions(events, port, {
      create(input) {
        const stack = baseOptions([], port).create(input);
        return {
          ...stack,
          admission: admission(async () => {
            events.push('handle:slow');
            entered();
            await handlerGate;
            events.push('handler-finished');
            return { statusCode: 200, body: { completed: true } };
          }),
          async stop() {
            events.push('stop-stack');
            return 'stopped';
          },
        };
      },
    }),
  );
  const admitted = request(port, '/api/v3/slow');
  await enteredPromise;
  const stopping = application.stop();
  assert.deepEqual(await request(port, '/readyz'), {
    statusCode: 503,
    body: { status: 'not_ready' },
  });
  assert.equal(events.includes('stop-stack'), false);
  release();
  assert.deepEqual(await admitted, {
    statusCode: 503,
    body: { code: 'admission_draining' },
  });
  assert.equal(await stopping, 'stopped');
  assert.ok(events.indexOf('handler-finished') < events.indexOf('stop-stack'));
  assert.ok(events.indexOf('stop-stack') < events.indexOf('close-database'));
});

test('a database availability signal withdraws admission but keeps liveness', async () => {
  const events = [];
  const port = await freePort();
  const availability = new ClusterControlAvailabilityFence();
  const application = await startClusterControlApplication(
    baseOptions(events, port, { availability }),
  );
  assert.equal(application.availabilityStatus(), 'ready');
  assert.equal((await request(port, '/readyz')).statusCode, 200);

  const unavailable = new Error('PostgreSQL connection lost');
  assert.equal(await availability.signal(unavailable), 'signaled');
  assert.equal(await application.unavailable, unavailable);
  assert.equal(application.availabilityStatus(), 'unavailable');
  assert.deepEqual(await request(port, '/readyz'), {
    statusCode: 503,
    body: { status: 'not_ready' },
  });
  assert.equal((await request(port, '/livez')).statusCode, 200);
  assert.deepEqual(
    await request(port, '/api/v3/runs', {
      method: 'POST',
      body: { taskId: 'task-1' },
    }),
    { statusCode: 503, body: { code: 'not_ready' } },
  );
  assert.ok(events.indexOf('stop-stack') < events.indexOf('close-database'));

  assert.equal(await application.stop(), 'stopped');
  assert.equal(application.availabilityStatus(), 'stopped');
  await assert.rejects(request(port, '/livez'));
});

test('an availability signal raised before startup cannot open admission', async () => {
  const events = [];
  const port = await freePort();
  const availability = new ClusterControlAvailabilityFence();
  assert.equal(
    await availability.signal(new Error('PostgreSQL unavailable at startup')),
    'signaled',
  );

  await assert.rejects(
    startClusterControlApplication(baseOptions(events, port, { availability })),
    (error) => error?.code === 'CLUSTER_CONTROL_DATABASE_UNAVAILABLE',
  );
  assert.ok(events.indexOf('stop-stack') < events.indexOf('close-database'));
  await assert.rejects(request(port, '/livez'));
});

test('readiness failure closes both PostgreSQL and the probe listener', async () => {
  const events = [];
  const port = await freePort();
  await assert.rejects(
    startClusterControlApplication(
      baseOptions(events, port, {
        async openDatabase() {
          events.push('open-database');
          return databaseResource(events, { serverVersionNum: '150018' });
        },
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_version_unsupported',
  );
  assert.equal(events.includes('create-stack'), false);
  assert.deepEqual(events.slice(-2), ['audit:failed', 'close-database']);
  await assert.rejects(request(port, '/livez'));
});
