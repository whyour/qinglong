const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresSchemaReadinessError,
  postgresqlControlSchemaContract,
  postgresqlMainMigrationStream,
} = require('@qinglong/cluster-postgres');
const { bootstrapClusterControlRuntime } = require('@qinglong/cluster-control');

function migrationHistory() {
  return postgresqlMainMigrationStream.migrations.map((migration, index) => ({
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
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
    plugin_package_automation_publication_heads: [true, false, false, false],
    plugin_package_workflow_admissions: [true, true, false, false],
    plugin_package_workflow_admission_steps: [true, true, false, false],
    plugin_package_workflow_task_attempt_admissions: [true, true, false, false],
    worker_execution_attestations: [true, false, false, false],
    run_events: [true, true, false, false],
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

function databaseResource(events, overrides = {}) {
  const contract = postgresqlControlSchemaContract;
  const pool = {
    async query(text) {
      events.push(
        `query:${
          events.filter((event) => event.startsWith('query:')).length + 1
        }`,
      );
      if (text.includes("current_setting('server_version_num')")) {
        return {
          rows: [
            {
              serverVersionNum: overrides.serverVersionNum ?? '160014',
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
        return {
          rows: contract.indexes.map((indexName) => ({ indexName })),
        };
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
            ].includes(functionName),
            isOwner: false,
          })),
        };
      }
      if (
        overrides.runtimeScans &&
        text.includes('JOIN LATERAL') &&
        text.includes('"ql3"."run_retry_policies"')
      ) {
        events.push('scan:lost-retry');
        return { rows: [], rowCount: 0 };
      }
      if (
        text.includes('WITH observation AS') &&
        !text.includes('FROM "ql3"."trigger_schedules"')
      ) {
        return {
          rows: overrides.recoveryRows ?? [
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
      if (
        overrides.runtimeScans &&
        text.includes('FROM "ql3"."trigger_schedules"')
      ) {
        events.push('scan:schedules');
        return { rows: [], rowCount: 0 };
      }
      if (
        overrides.runtimeScans &&
        text.includes(
          'FROM "ql3"."plugin_package_workflow_admissions" AS admission',
        )
      ) {
        events.push('scan:workflow-frontier');
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async connect() {
      if (overrides.runtimeScans) {
        return {
          async query(text) {
            if (
              text === 'BEGIN ISOLATION LEVEL READ COMMITTED' ||
              text.startsWith('SET LOCAL ') ||
              text === 'COMMIT' ||
              text === 'ROLLBACK'
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (
              text.includes('attempt.lease_expires_at_ms') &&
              text.includes('LEFT JOIN candidates AS candidate')
            ) {
              events.push('scan:runtime-recovery');
              return {
                rows: [
                  {
                    observedAtMs: '1',
                    attemptId: null,
                    runId: null,
                    status: null,
                    createdAtMs: null,
                  },
                ],
                rowCount: 1,
              };
            }
            if (
              text.includes(
                '"ql3"."plugin_package_workflow_task_attempt_admissions"',
              )
            ) {
              events.push('scan:workflow-task-attempts');
              return { rows: [], rowCount: 0 };
            }
            throw new Error(`unexpected repository query: ${text}`);
          },
          release() {
            events.push('release:workflow-task-attempts');
          },
        };
      }
      throw new Error('Repository connections are not used during bootstrap');
    },
  };
  return {
    pool,
    async close() {
      events.push('close-database');
      if (overrides.closeError) throw overrides.closeError;
    },
  };
}

function activationStack(
  events,
  recovery = { safe: true, remaining: 0, failed: 0 },
) {
  return {
    async reconcile() {
      events.push('reconcile');
      return recovery;
    },
    async startLifecycles() {
      events.push('start-lifecycles');
      return true;
    },
    installAdmission() {
      events.push('install-admission');
      return () => events.push('dispose-admission');
    },
    async stop() {
      events.push('stop-stack');
      return 'stopped';
    },
  };
}

function bootstrapOptions(events, overrides = {}) {
  return {
    enabled: true,
    profile: 'cluster-control',
    apiCredentialPepper: 'A'.repeat(43),
    recovery: { ownerId: 'test-replica', providers: [] },
    async openDatabase() {
      events.push('open-database');
      return databaseResource(events);
    },
    create(input) {
      const {
        evidence,
        authenticator,
        policies,
        runs,
        runCancellation,
        taskDefinitions,
        taskExecutionRevisions,
        triggers,
        schedules,
        trustedToolStorage,
        securityAudit,
      } = input;
      events.push('create-stack');
      assert.equal('pool' in input, false);
      assert.equal('recovery' in input, false);
      assert.equal('recoveryClaims' in input, false);
      assert.equal('recoveryTransitions' in input, false);
      assert.equal(
        evidence.contractVersion,
        postgresqlControlSchemaContract.contractVersion,
      );
      assert.equal(typeof authenticator.authenticate, 'function');
      assert.equal(typeof policies.resolve, 'function');
      assert.equal(typeof runs.transaction, 'function');
      assert.equal(typeof runCancellation.requestUserCancellation, 'function');
      assert.equal(
        typeof taskDefinitions.findCurrentTaskDefinition,
        'function',
      );
      assert.equal('appendTaskDefinitionRevision' in taskDefinitions, false);
      assert.equal(
        typeof taskExecutionRevisions.resolveClusterTaskExecutionRevision,
        'function',
      );
      assert.equal(typeof triggers.findCurrentTrigger, 'function');
      assert.equal('appendTriggerRevision' in triggers, false);
      assert.equal(typeof schedules.claimNextClusterSchedule, 'function');
      assert.equal(typeof schedules.commitClusterScheduleDecision, 'function');
      assert.equal(Object.isFrozen(trustedToolStorage), true);
      assert.equal(
        typeof trustedToolStorage.invocationArtifacts.findInput,
        'function',
      );
      assert.equal(typeof trustedToolStorage.stepRuns.findById, 'function');
      assert.equal(
        typeof trustedToolStorage.startBarriers.findByStartId,
        'function',
      );
      assert.equal(
        typeof trustedToolStorage.completions.findByStartId,
        'function',
      );
      assert.equal(
        typeof trustedToolStorage.failureCompletions.findByStartId,
        'function',
      );
      assert.equal(
        typeof trustedToolStorage.resultKeyCatalog.findCurrent,
        'function',
      );
      assert.equal(trustedToolStorage.resultKeyCatalog.append, undefined);
      assert.equal(
        typeof trustedToolStorage.resultRekeys.findHeadByArtifactId,
        'function',
      );
      assert.equal(trustedToolStorage.resultRekeys.append, undefined);
      assert.equal(
        typeof trustedToolStorage.toolDefinitionSnapshots.findCurrent,
        'function',
      );
      assert.equal(typeof securityAudit.record, 'function');
      return activationStack(events);
    },
    audit(record) {
      events.push(`audit:${record.state}`);
    },
    ...overrides,
  };
}

test('disabled and wrong-profile bootstrap never opens PostgreSQL', async () => {
  const disabledEvents = [];
  const disabled = await bootstrapClusterControlRuntime(
    bootstrapOptions(disabledEvents, { enabled: false }),
  );
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabledEvents, ['audit:disabled']);

  const wrongProfileEvents = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(wrongProfileEvents, { profile: 'edge' }),
    ),
    /cannot activate cluster-control/,
  );
  assert.deepEqual(wrongProfileEvents, []);
});

test('rejects a missing credential pepper before opening PostgreSQL', async () => {
  const events = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(events, { apiCredentialPepper: undefined }),
    ),
    /API credential configuration is invalid/,
  );
  assert.deepEqual(events, []);
});

test('rejects missing or unbounded recovery configuration before opening PostgreSQL', async () => {
  const missingEvents = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(missingEvents, { recovery: undefined }),
    ),
    /requires bounded recovery configuration/,
  );
  assert.deepEqual(missingEvents, []);

  const timeoutEvents = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(timeoutEvents, {
        recovery: {
          ownerId: 'test-replica',
          claimLeaseMs: 1_000,
          providerTimeoutMs: 900,
        },
      }),
    ),
    /250ms for fenced settlement/,
  );
  assert.deepEqual(timeoutEvents, []);

  const localClockEvents = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(localClockEvents, {
        scheduler: { clock: () => 1 },
      }),
    ),
    /scheduler configuration is invalid/,
  );
  assert.deepEqual(localClockEvents, []);
});

test('readiness failure closes the database before returning the root error', async () => {
  const events = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(events, {
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
});

test('opens once, assembles after readiness, and closes after stack shutdown', async () => {
  const events = [];
  const result = await bootstrapClusterControlRuntime(bootstrapOptions(events));
  assert.equal(result.status, 'active');
  assert.equal(events.filter((event) => event === 'open-database').length, 1);
  assert.ok(events.indexOf('create-stack') > events.lastIndexOf('query:8'));
  const first = result.stop();
  assert.equal(first, result.stop());
  assert.equal(await first, 'stopped');
  assert.deepEqual(events.slice(-4), [
    'dispose-admission',
    'stop-stack',
    'audit:stopped',
    'close-database',
  ]);
});

test('injects reviewed Worker operations without exposing the runtime Pool', async () => {
  const events = [];
  const artifactStore = {
    async put() {
      throw new Error('not invoked during assembly');
    },
    async inspect() {
      throw new Error('not invoked during assembly');
    },
    async readLogRange() {
      throw new Error('not invoked during assembly');
    },
  };
  const result = await bootstrapClusterControlRuntime(
    bootstrapOptions(events, {
      workerRuntime: { artifactStore },
      create(input) {
        events.push('create-stack');
        assert.equal('pool' in input, false);
        assert.equal(Object.isFrozen(input.workerRuntime), true);
        assert.equal(typeof input.workerRuntime.offers.claimNext, 'function');
        assert.equal(
          typeof input.workerRuntime.activation.acknowledgeStarting,
          'function',
        );
        assert.equal(input.workerRuntime.secrets, undefined);
        assert.equal(typeof input.workerRuntime.artifacts.upload, 'function');
        assert.equal(
          typeof input.workerRuntime.completion.complete,
          'function',
        );
        assert.equal(
          typeof input.workerRuntime.leaseControl.control,
          'function',
        );
        assert.equal(
          typeof input.workerRuntime.runAttemptLogRead.read,
          'function',
        );
        return activationStack(events);
      },
    }),
  );
  assert.equal(result.status, 'active');
  assert.equal(await result.stop(), 'stopped');
});

test('production scheduler cadence scans schedules, Workflow frontier, and Task Attempt admission', async () => {
  const events = [];
  let resolveCycle;
  const cycle = new Promise((resolve) => {
    resolveCycle = resolve;
  });
  const result = await bootstrapClusterControlRuntime(
    bootstrapOptions(events, {
      scheduler: {
        intervalMs: 250,
        onDiagnostic(error, summary) {
          resolveCycle({ error, summary });
        },
      },
      cancellationConvergence: { intervalMs: 60 * 60_000 },
      async openDatabase() {
        events.push('open-database');
        return databaseResource(events, { runtimeScans: true });
      },
    }),
  );

  const observed = await Promise.race([
    cycle,
    new Promise((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('production scheduler cycle did not run')),
        2_000,
      );
      timeout.unref?.();
    }),
  ]);
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.summary, {
    firstClaimAcquiredAtMs: null,
    lastClaimAcquiredAtMs: null,
    claimed: 0,
    initialized: 0,
    skipped: 0,
    admitted: 0,
    raced: 0,
    saturated: false,
  });
  assert.deepEqual(
    events.filter((event) => event.startsWith('scan:')),
    [
      'scan:runtime-recovery',
      'scan:lost-retry',
      'scan:schedules',
      'scan:workflow-frontier',
      'scan:workflow-task-attempts',
    ],
  );
  assert.equal(await result.stop(), 'stopped');
  assert.ok(events.includes('release:workflow-task-attempts'));
});

test('unsafe recovery stops the stack and closes the database', async () => {
  const events = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(events, {
        create({ runs }) {
          events.push('create-stack');
          assert.equal(typeof runs.findRunById, 'function');
          return activationStack(events, {
            safe: false,
            remaining: 1,
            failed: 0,
          });
        },
      }),
    ),
    /did not converge safely/,
  );
  assert.equal(events.includes('install-admission'), false);
  assert.deepEqual(events.slice(-3), [
    'stop-stack',
    'audit:failed',
    'close-database',
  ]);
});

test('bootstrap-owned recovery blocks a false-safe stack when the claim store is unavailable', async () => {
  const events = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(events, {
        async openDatabase() {
          events.push('open-database');
          return databaseResource(events, {
            recoveryRows: [
              {
                observedAtMs: '1',
                kind: 'run',
                id: 'run-1',
                runId: 'run-1',
                status: 'running',
                createdAtMs: '1',
              },
              {
                observedAtMs: '1',
                kind: 'attempt',
                id: 'attempt-1',
                runId: 'run-1',
                status: 'running',
                createdAtMs: '2',
              },
            ],
          });
        },
      }),
    ),
    (error) =>
      error?.name === 'ClusterControlRecoveryStoreError' &&
      error.retryable === true,
  );
  assert.equal(events.includes('install-admission'), false);
  assert.equal(events.includes('reconcile'), false);
  assert.deepEqual(events.slice(-3), [
    'stop-stack',
    'audit:failed',
    'close-database',
  ]);
});

test('database close failure does not skip stack shutdown and remains idempotent', async () => {
  const events = [];
  const closeError = new Error('database close failed');
  const result = await bootstrapClusterControlRuntime(
    bootstrapOptions(events, {
      async openDatabase() {
        events.push('open-database');
        return databaseResource(events, { closeError });
      },
    }),
  );
  const first = result.stop();
  assert.equal(first, result.stop());
  await assert.rejects(first, (error) => error === closeError);
  assert.deepEqual(events.slice(-4), [
    'dispose-admission',
    'stop-stack',
    'audit:stopped',
    'close-database',
  ]);
});
