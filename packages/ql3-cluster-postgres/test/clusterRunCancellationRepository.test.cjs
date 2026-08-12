'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
} = require('@qinglong/runtime-core/cluster-run-cancellation');
const {
  PostgresClusterRunCancellationRepository,
} = require('../dist/entrypoints/runtime');

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: 'mutation-1',
    eventId: '018f0000-0000-7000-8000-000000000001',
    subject: { type: 'user', id: 'user-1' },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    projectId: 'project-1',
    runStatus: 'running',
    runVersion: 4,
    eventSequence: 6,
    cancelRequestedAtMs: null,
    cancelReason: null,
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (
        normalized.startsWith('BEGIN') ||
        normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' ||
        normalized.startsWith('SELECT set_config')
      )
        return { rows: [], rowCount: 0 };
      if (normalized.includes('lock_run_management_policy_fence')) {
        return {
          rows: [{ matches: options.policyMatches ?? true }],
          rowCount: 1,
        };
      }
      if (normalized.includes('FROM "ql3"."projects"')) {
        return {
          rows: options.projectRows ?? [
            {
              projectStatus: 'active',
              projectVersion: 2,
            },
          ],
          rowCount: 1,
        };
      }
      if (normalized.includes('FROM "ql3"."project_role_bindings"')) {
        return {
          rows: options.bindingRows ?? [
            {
              bindingVersion: 3,
              bindingState: 'active',
              bindingRole: 'operator',
            },
          ],
          rowCount: 1,
        };
      }
      if (
        normalized.includes('FROM "ql3"."runs"') &&
        normalized.startsWith('SELECT')
      ) {
        return {
          rows: options.runRows ?? [run()],
          rowCount: options.runRows?.length ?? 1,
        };
      }
      if (
        normalized.includes('FROM "ql3"."plugin_package_workflow_admissions"')
      ) {
        const rows = options.workflowAdmissionRows ?? [
          {
            projectId: 'project-1',
            packageName: 'example',
            workflowId: 'daily',
          },
        ];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: options.nowMs ?? 1_000 }], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE "ql3"."runs"')) {
        return {
          rows: options.updatedRows ?? [
            run({
              runVersion: 5,
              eventSequence: 7,
              cancelRequestedAtMs: options.nowMs ?? 1_000,
              cancelReason: 'user',
            }),
          ],
          rowCount: options.updatedRows?.length ?? 1,
        };
      }
      if (normalized.startsWith('INSERT INTO "ql3"."run_events"')) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO "ql3"."security_audit_events"')) {
        return {
          rows: options.auditInserted === false ? [] : [{ eventId: params[0] }],
          rowCount: options.auditInserted === false ? 0 : 1,
        };
      }
      if (normalized.includes('FROM "ql3"."security_audit_events"')) {
        return { rows: options.auditReplayRows ?? [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    repository: new PostgresClusterRunCancellationRepository({
      async connect() {
        return client;
      },
    }),
    calls,
  };
}

test('revalidates policy authority and commits one database-timed intent', async () => {
  const { repository, calls } = fixture();
  assert.deepEqual(await repository.requestUserCancellation(command()), {
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 1_000,
    cancelReason: 'user',
  });
  const policyIndex = calls.findIndex(({ sql }) =>
    sql.includes('lock_run_management_policy_fence'),
  );
  const runIndex = calls.findIndex(({ sql }) =>
    sql.includes('FROM "ql3"."runs"'),
  );
  assert.ok(policyIndex >= 0 && policyIndex < runIndex);
  const update = calls.find(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"'));
  assert.deepEqual(update.params, ['run-1', 1_000, 5, 7, 4]);
  const event = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"'),
  );
  assert.equal(event.params[0], command().eventId);
  assert.equal(event.params[3], 'user-cancel:mutation-1');
  assert.equal(event.params[4], 'user');
  assert.equal(JSON.parse(event.params[6]).reason, 'user');
  assert.equal(
    calls.some(({ sql }) => sql === 'COMMIT'),
    true,
  );
});

test('returns existing intent and terminal state without adding an event', async () => {
  const existing = fixture({
    runRows: [run({ cancelRequestedAtMs: 900, cancelReason: 'timeout' })],
  });
  assert.equal(
    (await existing.repository.requestUserCancellation(command())).status,
    'already_requested',
  );
  assert.equal(
    existing.calls.some(({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."run_events"'),
    ),
    false,
  );

  const terminal = fixture({
    runRows: [run({ runStatus: 'succeeded', runVersion: 5 })],
  });
  assert.equal(
    (await terminal.repository.requestUserCancellation(command())).status,
    'already_terminal',
  );
  assert.equal(
    terminal.calls.some(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"')),
    false,
  );
});

test('accepts cancellation for a lost Run that still owns retry authority', async () => {
  const { repository } = fixture({
    runRows: [run({ runStatus: 'lost' })],
    updatedRows: [
      run({
        runStatus: 'lost',
        runVersion: 5,
        eventSequence: 7,
        cancelRequestedAtMs: 1_000,
        cancelReason: 'user',
      }),
    ],
  });
  assert.equal(
    (await repository.requestUserCancellation(command())).status,
    'accepted',
  );
});

test('rejects a revoked policy fence before locking the Run', async () => {
  const { repository, calls } = fixture({
    policyMatches: false,
  });
  await assert.rejects(
    repository.requestUserCancellation(command()),
    (error) =>
      error instanceof ClusterRunCancellationFenceRejectedError &&
      error.reason === 'authorization_changed',
  );
  assert.equal(
    calls.some(({ sql }) => sql.includes('FROM "ql3"."runs"')),
    false,
  );
  assert.equal(
    calls.some(({ sql }) => sql === 'ROLLBACK'),
    true,
  );
});

test('atomically records strong management audit and exact audit replay', async () => {
  const { repository, calls } = fixture();
  const { subject: _subject, ...baseCommand } = command();
  const managed = {
    ...baseCommand,
    mutationId: '019f0000-0000-4000-8000-000000000001',
    requestId: 'request-stop-1',
    auditEventId: '019f0000-0000-4000-8000-000000000002',
    principal: {
      subject: command().subject,
      authenticationId: 'oidc:run-management-1',
      authenticatedAtMs: 900,
      expiresAtMs: 2_000,
      assurance: 'hardware',
    },
  };
  const result = await repository.requestUserCancellationAudited(managed);
  assert.equal(result.status, 'accepted');
  const audit = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."security_audit_events"'),
  );
  assert.equal(audit.params[0], managed.auditEventId);
  assert.equal(audit.params[1], managed.requestId);
  assert.equal(audit.params[5], managed.principal.authenticationId);
  assert.ok(
    calls.findIndex(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"')) <
      calls.findIndex(({ sql }) =>
        sql.startsWith('INSERT INTO "ql3"."security_audit_events"'),
      ),
  );
  assert.ok(
    calls.findIndex(({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"'),
    ) < calls.findIndex(({ sql }) => sql === 'COMMIT'),
  );

  const replay = fixture({
    runRows: [run({ cancelRequestedAtMs: 1_000, cancelReason: 'user' })],
    auditInserted: false,
    auditReplayRows: [
      {
        requestId: managed.requestId,
        operationId: 'run.stop',
        projectId: managed.projectId,
        subjectType: 'user',
        subjectId: 'user-1',
        authenticationId: managed.principal.authenticationId,
        outcome: 'allowed',
        reasons: ['role_grant', 'strong_authentication'],
        projectVersion: 2,
        bindingVersion: 3,
      },
    ],
  });
  assert.equal(
    (await replay.repository.requestUserCancellationAudited(managed)).status,
    'already_requested',
  );
  assert.equal(
    replay.calls.some(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"')),
    false,
  );
});

test('masks cross-Project and missing Runs', async () => {
  for (const runRows of [[], [run({ projectId: 'project-other' })]]) {
    const { repository } = fixture({ runRows });
    await assert.rejects(
      repository.requestUserCancellation(command()),
      ClusterRunCancellationNotFoundError,
    );
  }
});

test('binds Workflow cancellation to the immutable admission target', async () => {
  const targeted = command({
    workflowTarget: { packageName: 'example', workflowId: 'daily' },
  });
  const accepted = fixture();
  assert.equal(
    (await accepted.repository.requestUserCancellation(targeted)).status,
    'accepted',
  );
  const admission = accepted.calls.find(({ sql }) =>
    sql.includes('FROM "ql3"."plugin_package_workflow_admissions"'),
  );
  assert.deepEqual(admission.params, ['run-1']);
  assert.equal(
    admission.sql.includes('FOR SHARE'),
    false,
    'immutable admission lookup must not require UPDATE authority',
  );

  for (const workflowAdmissionRows of [
    [],
    [
      {
        projectId: 'project-1',
        packageName: 'other',
        workflowId: 'daily',
      },
    ],
    [
      {
        projectId: 'project-1',
        packageName: 'example',
        workflowId: 'other',
      },
    ],
  ]) {
    const rejected = fixture({ workflowAdmissionRows });
    await assert.rejects(
      rejected.repository.requestUserCancellation(targeted),
      ClusterRunCancellationNotFoundError,
    );
    assert.equal(
      rejected.calls.some(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"')),
      false,
    );
  }
});
