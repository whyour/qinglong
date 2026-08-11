const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const { ProjectPolicyEngine } = require('@qinglong/runtime-core/project-policy');
const {
  PostgresProjectPolicyRepository,
  PostgresTaskDefinitionAdministrationRepository,
  PostgresTriggerAdministrationRepository,
  assertPostgresAutomationManagerSchemaReady,
  createPostgresDatabaseOpener,
} = require('@qinglong/cluster-postgres/automation-manager');
const {
  runPostgresMigrations,
} = require('@qinglong/cluster-postgres/migration');
const {
  createClusterAutomationManagementService,
} = require('@qinglong/cluster-admin/automation-management');
const {
  executeClusterAutomationManagementClient,
} = require('@qinglong/cluster-admin/automation-management-client');
const {
  startClusterAutomationManagementHttp,
} = require('@qinglong/cluster-admin/automation-management-http');
const {
  createClusterAutomationManagementTransport,
} = require('@qinglong/cluster-admin/automation-management-transport');

const MIGRATION_URL = process.env.QL3_TEST_POSTGRES_URL;
const AUTOMATION_URL =
  process.env.QL3_TEST_POSTGRES_AUTOMATION_MANAGER_URL;
const FIXTURES = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);

function opener(role, connectionString, applicationName) {
  return createPostgresDatabaseOpener({
    role,
    connection: {
      connectionString,
      tls: { mode: 'disable' },
    },
    pool: { maxConnections: 2, applicationName },
    onPoolError(error) {
      throw error;
    },
  });
}

const principal = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'automation-operator' }),
  authenticationId: 'oidc:automation-live-contract',
  authenticatedAtMs: 1,
  expiresAtMs: 4_102_444_800_000,
  assurance: 'hardware',
});

const identities = Object.freeze({
  async reload() {
    return Object.freeze({
      schemaVersion: 1,
      generation: 1,
      digest: 'automation-live-contract',
      issuer: 'https://identity.example.test/',
      audience: 'qinglong3-automation-management',
      activeKeyIds: Object.freeze(['automation-live-key']),
      revokedKeyIds: Object.freeze([]),
    });
  },
  bind() {
    return Object.freeze({
      async authenticate() {
        return principal;
      },
    });
  },
});

function privateWrite(filePath, value) {
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function clientFiles(port, command, directories) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-automation-pg-client-')),
  );
  directories.push(directory);
  const caFile = join(directory, 'ca.crt');
  const clientCertificateFile = join(directory, 'client.crt');
  const clientPrivateKeyFile = join(directory, 'client.key');
  const paths = {
    configFile: join(directory, 'client.json'),
    commandFile: join(directory, 'command.json'),
    assertionFile: join(directory, 'assertion.jwt'),
  };
  privateWrite(caFile, readFileSync(join(FIXTURES, 'ca-cert.pem')));
  privateWrite(
    clientCertificateFile,
    readFileSync(join(FIXTURES, 'client-cert.pem')),
  );
  privateWrite(
    clientPrivateKeyFile,
    readFileSync(join(FIXTURES, 'client-key.pem')),
  );
  privateWrite(
    paths.configFile,
    `${JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${port}/api/v3/automations/management`,
      servername: 'localhost',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 5_000,
    })}\n`,
  );
  privateWrite(paths.commandFile, `${JSON.stringify(command)}\n`);
  privateWrite(
    paths.assertionFile,
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );
  return paths;
}

function envelope(operation, requestId, command) {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: Object.freeze({ requestId, command }),
  });
}

function readEnvelope(operation, request) {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: Object.freeze(request),
  });
}

function taskCommand(projectId, revision, suffix, value) {
  return Object.freeze({
    projectId,
    taskId: 'managed-task',
    expectedRevision: revision,
    mutationId: `123e4567-e89b-42d3-a456-426614176${suffix}`,
    name: 'Managed Task',
    kind: 'command',
    spec: Object.freeze({
      schema: 'qinglong/command@v1',
      config: Object.freeze({
        command: Object.freeze({
          kind: 'argv',
          file: '/bin/echo',
          args: Object.freeze([value]),
        }),
      }),
    }),
    labels: Object.freeze({}),
    enabled: true,
    occurredAtMs: 1_000 + Number(suffix),
  });
}

function triggerCommand(projectId, revision, task, suffix) {
  return Object.freeze({
    projectId,
    triggerId: 'managed-trigger',
    expectedRevision: revision,
    mutationId: `123e4567-e89b-42d3-a456-426614177${suffix}`,
    taskId: task.taskId,
    taskRevision: task.revision,
    taskContentDigest: task.contentDigest,
    spec: Object.freeze({
      schema: 'qinglong/cron@v1',
      config: Object.freeze({
        expression: '*/5 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      }),
    }),
    enabled: true,
    occurredAtMs: 2_000 + Number(suffix),
  });
}

function buildTransport(database) {
  return createClusterAutomationManagementTransport({
    service: createClusterAutomationManagementService({
      policy: new ProjectPolicyEngine(
        new PostgresProjectPolicyRepository(database.pool),
      ),
      taskDefinitions: new PostgresTaskDefinitionAdministrationRepository(
        database.pool,
      ),
      triggers: new PostgresTriggerAdministrationRepository(database.pool),
    }),
  });
}

async function startManager(transport, sequence) {
  return startClusterAutomationManagementHttp({
    host: 'localhost',
    port: 0,
    tls: {
      privateKey: Buffer.from(readFileSync(join(FIXTURES, 'server-key.pem'))),
      certificate: Buffer.from(
        readFileSync(join(FIXTURES, 'server-cert.pem')),
      ),
      clientCertificateAuthority: Buffer.from(
        readFileSync(join(FIXTURES, 'ca-cert.pem')),
      ),
      clientCertificateRevocationList: Buffer.from(
        readFileSync(join(FIXTURES, 'empty-crl.pem')),
      ),
    },
    transport,
    identities,
    createRequestId: () => `manager-${sequence.value++}`,
  });
}

if (!MIGRATION_URL || !AUTOMATION_URL) {
  test('automation PostgreSQL HTTPS integration requires migration and automation-manager URLs', {
    skip: true,
  });
} else {
  test(
    'two HTTPS managers converge concurrent publish and commit-response loss on real PostgreSQL',
    { timeout: 60_000 },
    async () => {
      const directories = [];
      const sequence = { value: 1 };
      const migration = await opener(
        'migration',
        MIGRATION_URL,
        'ql3-automation-live-migration',
      )();
      const firstDatabase = await opener(
        'automation-manager',
        AUTOMATION_URL,
        'ql3-automation-live-first',
      )();
      const secondDatabase = await opener(
        'automation-manager',
        AUTOMATION_URL,
        'ql3-automation-live-second',
      )();
      let first;
      let second;
      let responseLoss;
      try {
        await runPostgresMigrations({ pool: migration.pool });
        const readiness = await Promise.all([
          assertPostgresAutomationManagerSchemaReady(firstDatabase.pool),
          assertPostgresAutomationManagerSchemaReady(secondDatabase.pool),
        ]);
        assert.deepEqual(
          readiness.map((entry) => entry.currentUser),
          ['ql3_automation_manager', 'ql3_automation_manager'],
        );
        const observed = await migration.pool.query(
          `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                  AS "observedAtMs"`,
        );
        const occurredAtMs = Number(observed.rows[0].observedAtMs);
        const projectId = `automation-https-${process.pid}`;
        await migration.pool.query(
          `DELETE FROM "ql3"."projects" WHERE id = $1`,
          [projectId],
        );
        await migration.pool.query(
          `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ($1, 'Automation HTTPS', $1, 'active', 1, $2, $2)`,
          [projectId, occurredAtMs],
        );
        await migration.pool.query(
          `INSERT INTO "ql3"."project_role_bindings" (
             project_id, subject_type, subject_id, version, state, role,
             mutation_id, changed_by_type, changed_by_id, created_at_ms
           ) VALUES ($1, 'user', $2, 1, 'active', 'owner', $3,
                     'user', $2, $4)`,
          [
            projectId,
            principal.subject.id,
            '123e4567-e89b-42d3-a456-426614176000',
            occurredAtMs,
          ],
        );

        const firstTransport = buildTransport(firstDatabase);
        const secondTransport = buildTransport(secondDatabase);
        first = await startManager(firstTransport, sequence);
        second = await startManager(secondTransport, sequence);

        const createTask = envelope(
          'task.publish',
          'concurrent-task-create',
          taskCommand(projectId, null, '001', 'v1'),
        );
        const concurrent = await Promise.all([
          executeClusterAutomationManagementClient(
            clientFiles(first.address.port, createTask, directories),
          ),
          executeClusterAutomationManagementClient(
            clientFiles(second.address.port, createTask, directories),
          ),
        ]);
        assert.deepEqual(
          concurrent.map((entry) => entry.result.status).sort(),
          ['created', 'existing'],
        );
        const taskV1 = concurrent[0].result.task;

        let dropCommittedResponse = true;
        responseLoss = await startManager(
          Object.freeze({
            async execute(command, authentication) {
              const result = await firstTransport.execute(
                command,
                authentication,
              );
              if (dropCommittedResponse) {
                dropCommittedResponse = false;
                throw new Error('simulated post-commit response loss');
              }
              return result;
            },
          }),
          sequence,
        );
        const updateTask = envelope(
          'task.publish',
          'response-loss-task-update',
          taskCommand(projectId, 1, '002', 'v2'),
        );
        await assert.rejects(
          executeClusterAutomationManagementClient(
            clientFiles(responseLoss.address.port, updateTask, directories),
          ),
          (error) =>
            error?.statusCode === 500 &&
            error?.responseCode === 'internal_error',
        );
        const converged = await executeClusterAutomationManagementClient(
          clientFiles(second.address.port, updateTask, directories),
        );
        assert.equal(converged.result.status, 'existing');
        assert.equal(converged.result.task.revision, 2);

        const createTrigger = envelope(
          'trigger.publish',
          'trigger-create-v2',
          triggerCommand(projectId, null, converged.result.task, '001'),
        );
        const triggerV1 = await executeClusterAutomationManagementClient(
          clientFiles(first.address.port, createTrigger, directories),
        );
        assert.equal(triggerV1.result.status, 'created');
        assert.equal(triggerV1.result.trigger.taskRevision, 2);

        const taskV3 = await executeClusterAutomationManagementClient(
          clientFiles(
            second.address.port,
            envelope(
              'task.publish',
              'task-update-v3',
              taskCommand(projectId, 2, '003', 'v3'),
            ),
            directories,
          ),
        );
        const triggerV2 = await executeClusterAutomationManagementClient(
          clientFiles(
            first.address.port,
            envelope(
              'trigger.publish',
              'trigger-repin-v3',
              triggerCommand(projectId, 1, taskV3.result.task, '002'),
            ),
            directories,
          ),
        );
        assert.equal(triggerV2.result.status, 'updated');
        assert.equal(triggerV2.result.trigger.taskRevision, 3);

        const taskInspection = await executeClusterAutomationManagementClient(
          clientFiles(
            second.address.port,
            readEnvelope('task.inspect', {
              requestId: 'task-inspect-v3',
              auditEventId: '123e4567-e89b-42d3-a456-426614178001',
              projectId,
              taskId: 'managed-task',
            }),
            directories,
          ),
        );
        assert.equal(taskInspection.result.status, 'found');
        assert.equal(taskInspection.result.task.revision, 3);
        const taskPage = await executeClusterAutomationManagementClient(
          clientFiles(
            first.address.port,
            readEnvelope('task.list', {
              requestId: 'task-list-v3',
              auditEventId: '123e4567-e89b-42d3-a456-426614178002',
              projectId,
              limit: 1,
            }),
            directories,
          ),
        );
        assert.equal(taskPage.result.tasks.length, 1);
        assert.equal(taskPage.result.next, null);
        const triggerInspection =
          await executeClusterAutomationManagementClient(
            clientFiles(
              first.address.port,
              readEnvelope('trigger.inspect', {
                requestId: 'trigger-inspect-v2',
                auditEventId: '123e4567-e89b-42d3-a456-426614178003',
                projectId,
                triggerId: 'managed-trigger',
              }),
              directories,
            ),
          );
        assert.equal(triggerInspection.result.trigger.revision, 2);
        const triggerPage = await executeClusterAutomationManagementClient(
          clientFiles(
            second.address.port,
            readEnvelope('trigger.list', {
              requestId: 'trigger-list-v2',
              auditEventId: '123e4567-e89b-42d3-a456-426614178004',
              projectId,
              limit: 1,
            }),
            directories,
          ),
        );
        assert.equal(triggerPage.result.triggers.length, 1);
        assert.equal(triggerPage.result.next, null);
        assert.doesNotMatch(
          JSON.stringify([
            taskInspection.result,
            taskPage.result,
            triggerInspection.result,
            triggerPage.result,
          ]),
          /Managed Task|\/bin\/echo|expression|authenticationId|mutationId/,
        );

        const durable = await migration.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM "ql3"."task_definition_revisions"
               WHERE project_id = $1 AND task_id = 'managed-task') AS "taskRevisions",
             (SELECT current_revision FROM "ql3"."task_definitions"
               WHERE project_id = $1 AND task_id = 'managed-task') AS "taskHead",
             (SELECT count(*)::integer FROM "ql3"."trigger_revisions"
               WHERE project_id = $1 AND trigger_id = 'managed-trigger') AS "triggerRevisions",
             (SELECT current_revision FROM "ql3"."triggers"
               WHERE project_id = $1 AND trigger_id = 'managed-trigger') AS "triggerHead",
             (SELECT count(*)::integer FROM "ql3"."security_audit_events"
               WHERE project_id = $1 AND outcome = 'allowed') AS "allowedAudits"`,
          [projectId],
        );
        assert.deepEqual(durable.rows, [
          {
            taskRevisions: 3,
            taskHead: 3,
            triggerRevisions: 2,
            triggerHead: 2,
            allowedAudits: 9,
          },
        ]);
        assert.equal(taskV1.revision, 1);
      } finally {
        await Promise.allSettled([
          responseLoss?.close(),
          first?.close(),
          second?.close(),
        ]);
        await Promise.allSettled([
          firstDatabase.close(),
          secondDatabase.close(),
          migration.close(),
        ]);
        for (const directory of directories) {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  );
}
