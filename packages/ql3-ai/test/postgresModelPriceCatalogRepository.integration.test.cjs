const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const {
  ModelPriceCatalogConflictError,
  createModelPriceCatalogPublishCommand,
  createModelPriceCatalogTransitionCommand,
} = require('../dist/pricing/modelPriceCatalog.js');
const {
  migratePostgresModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  ModelPriceCatalogManagementSeparationOfDutyError,
  createModelPriceCatalogManagementService,
  createModelPriceCatalogPolicyDecision,
} = require('../dist/pricing/modelPriceCatalogManagement.js');
const {
  PostgresModelPriceCatalogReader,
  PostgresModelPriceCatalogRepository,
} = require('../dist/pricing/storage/postgresModelPriceCatalogRepository.js');

const migrationConnectionString =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL ??
  process.env.QL3_TEST_POSTGRES_URL;
const adminConnectionString = process.env.QL3_TEST_POSTGRES_ADMIN_URL;
const runtimeConnectionString = process.env.QL3_TEST_POSTGRES_RUNTIME_URL;

if (
  !migrationConnectionString ||
  !adminConnectionString ||
  !runtimeConnectionString
) {
  test(
    'PostgreSQL Model price catalog integration requires migration, admin and runtime URLs',
    { skip: true },
  );
} else {
  const clusterRequire = createRequire(
    path.resolve(__dirname, '../../ql3-cluster-postgres/package.json'),
  );
  const { Pool } = clusterRequire('pg');
  const {
    runPostgresMigrations,
  } = require('../../ql3-cluster-postgres/dist/migration/migration.js');

  function pool(connectionString, applicationName) {
    return new Pool({
      connectionString,
      ssl: false,
      max: 4,
      application_name: applicationName,
    });
  }

  function publish(provider, model, revision, mutationId, rate) {
    return createModelPriceCatalogPublishCommand({
      provider,
      model,
      priceRevision: revision,
      currency: 'USD',
      inputMicrosPerMillionTokens: rate,
      outputMicrosPerMillionTokens: rate * 4,
      mutationId,
      publishedByUserId: 'integration-admin',
    });
  }

  function transition(provider, model, head, action, revision, mutationId) {
    return createModelPriceCatalogTransitionCommand({
      provider,
      model,
      expectedGeneration: head?.generation ?? 0,
      expectedHeadDigest: head?.headDigest ?? null,
      action,
      priceRevision: revision,
      mutationId,
      changedByUserId: 'integration-admin',
    });
  }

  async function assertSqlState(operation, expected) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, expected);
      return true;
    });
  }

  test('PostgreSQL catalog serializes publication, activation and permanent revocation', async () => {
    const suffix = randomUUID();
    const provider = `integration-${suffix}`;
    const model = 'model-price-catalog';
    const migrationPool = pool(
      migrationConnectionString,
      'ql3-ai-price-catalog-migration-test',
    );
    const adminPool = pool(
      adminConnectionString,
      'ql3-ai-price-catalog-admin-test',
    );
    const runtimePool = pool(
      runtimeConnectionString,
      'ql3-ai-price-catalog-runtime-test',
    );
    const repository = new PostgresModelPriceCatalogRepository(adminPool);
    const reader = new PostgresModelPriceCatalogReader(runtimePool);

    try {
      await runPostgresMigrations({ pool: migrationPool });
      await migratePostgresModelInvocationFeature(migrationPool);

      const firstCommand = publish(
        provider,
        model,
        'price-1',
        `publish-1-${suffix}`,
        150_000,
      );
      const first = await repository.publish(firstCommand);
      assert.equal(first.status, 'created');
      assert.deepEqual(await repository.publish(firstCommand), {
        status: 'existing',
        publication: first.publication,
      });
      assert.equal(
        await reader.resolve({
          provider,
          model,
          priceRevision: 'price-1',
        }),
        null,
      );

      const second = await repository.publish(
        publish(provider, model, 'price-2', `publish-2-${suffix}`, 200_000),
      );
      const activated = await repository.transition(
        transition(
          provider,
          model,
          null,
          'activate',
          'price-1',
          `activate-1-${suffix}`,
        ),
      );
      assert.equal(
        (
          await reader.resolve({
            provider,
            model,
            priceRevision: 'price-1',
          })
        ).catalogDigest,
        first.publication.entry.catalogDigest,
      );

      const competitors = await Promise.allSettled([
        repository.transition(
          transition(
            provider,
            model,
            activated.head,
            'activate',
            'price-2',
            `activate-2-${suffix}`,
          ),
        ),
        repository.transition(
          transition(
            provider,
            model,
            activated.head,
            'deactivate',
            null,
            `deactivate-1-${suffix}`,
          ),
        ),
      ]);
      assert.equal(
        competitors.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        competitors.filter(
          (result) =>
            result.status === 'rejected' &&
            result.reason instanceof ModelPriceCatalogConflictError,
        ).length,
        1,
      );

      let current = await repository.findCurrent(provider, model);
      if (current.activePriceRevision !== 'price-2') {
        current = (
          await repository.transition(
            transition(
              provider,
              model,
              current,
              'activate',
              'price-2',
              `activate-2-after-race-${suffix}`,
            ),
          )
        ).head;
      }
      assert.equal(
        (
          await reader.resolve({
            provider,
            model,
            priceRevision: 'price-2',
          })
        ).catalogDigest,
        second.publication.entry.catalogDigest,
      );
      assert.equal(
        await reader.resolve({
          provider,
          model,
          priceRevision: 'price-1',
        }),
        null,
      );

      current = (
        await repository.transition(
          transition(
            provider,
            model,
            current,
            'revoke',
            'price-1',
            `revoke-1-${suffix}`,
          ),
        )
      ).head;
      assert.equal(current.activePriceRevision, 'price-2');
      current = (
        await repository.transition(
          transition(
            provider,
            model,
            current,
            'revoke',
            'price-2',
            `revoke-2-${suffix}`,
          ),
        )
      ).head;
      assert.equal(current.activePriceRevision, null);
      assert.equal(
        await reader.resolve({
          provider,
          model,
          priceRevision: 'price-2',
        }),
        null,
      );
      await assert.rejects(
        repository.transition(
          transition(
            provider,
            model,
            current,
            'activate',
            'price-2',
            `reactivate-2-${suffix}`,
          ),
        ),
        ModelPriceCatalogConflictError,
      );

      const privileges = await Promise.all([
        runtimePool.query(
          `SELECT
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_publications',
               'SELECT'
             ) AS publication_select,
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_publications',
               'INSERT'
             ) AS publication_insert,
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_heads',
               'SELECT'
             ) AS head_select,
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_heads',
               'INSERT'
             ) AS head_insert`,
        ),
        adminPool.query(
          `SELECT
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_publications',
               'SELECT'
             ) AND
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_publications',
               'INSERT'
             ) AS publication_append,
             NOT has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_publications',
               'UPDATE'
             ) AND NOT
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_publications',
               'DELETE'
             ) AS publication_no_rewrite,
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_heads',
               'SELECT'
             ) AND
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_heads',
               'INSERT'
             ) AS head_append,
             NOT has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_heads',
               'UPDATE'
             ) AND NOT
             has_table_privilege(
               current_user,
               'ql3_ai.model_price_catalog_heads',
               'DELETE'
             ) AS head_no_rewrite`,
        ),
      ]);
      assert.deepEqual(privileges[0].rows[0], {
        publication_select: true,
        publication_insert: false,
        head_select: true,
        head_insert: false,
      });
      assert.deepEqual(privileges[1].rows[0], {
        publication_append: true,
        publication_no_rewrite: true,
        head_append: true,
        head_no_rewrite: true,
      });
      await assertSqlState(
        runtimePool.query(
          `INSERT INTO "ql3_ai"."model_price_catalog_publications"
             (provider)
           VALUES ('forbidden')`,
        ),
        '42501',
      );
      await assertSqlState(
        adminPool.query(
          `UPDATE "ql3_ai"."model_price_catalog_heads"
              SET action = action
            WHERE provider = $1 AND model = $2`,
          [provider, model],
        ),
        '42501',
      );
    } finally {
      await runtimePool.end();
      await adminPool.end();
      await migrationPool.end();
    }
  });

  test('PostgreSQL atomically fences authorized catalog management and its ACL', async () => {
    const suffix = randomUUID();
    const provider = `authorized-${suffix}`;
    const model = 'managed-price-catalog';
    const now = Date.now();
    const migrationPool = pool(
      migrationConnectionString,
      'ql3-ai-price-authorization-migration-test',
    );
    const adminPool = pool(
      adminConnectionString,
      'ql3-ai-price-authorization-admin-test',
    );
    const runtimePool = pool(
      runtimeConnectionString,
      'ql3-ai-price-authorization-runtime-test',
    );
    const repository = new PostgresModelPriceCatalogRepository(adminPool);
    const service = createModelPriceCatalogManagementService(repository, {
      decisionMode: 'separation_of_duty',
      authorizer: {
        async authorize() {
          return createModelPriceCatalogPolicyDecision({
            effect: 'allow',
            revision: 'integration-platform-policy-1',
            reasons: ['catalog_operator'],
          });
        },
      },
      now: () => now,
    });
    const principal = (userId) => ({
      subject: { type: 'user', id: userId },
      authenticationId: `auth-${userId}`,
      authenticatedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      assurance: 'multi_factor',
    });
    const publishRequest = {
      authorizationId: `authorize-publish-${suffix}`,
      requestId: `request-publish-${suffix}`,
      mutationId: `publish-${suffix}`,
      provider,
      model,
      principal: principal('integration-publisher'),
      priceRevision: 'price-1',
      currency: 'USD',
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
    };
    const activateRequest = {
      authorizationId: `authorize-activate-${suffix}`,
      requestId: `request-activate-${suffix}`,
      mutationId: `activate-${suffix}`,
      provider,
      model,
      principal: principal('integration-reviewer'),
      expectedGeneration: 0,
      expectedHeadDigest: null,
      action: 'activate',
      priceRevision: 'price-1',
    };

    try {
      await runPostgresMigrations({ pool: migrationPool });
      await migratePostgresModelInvocationFeature(migrationPool);

      const publication = await service.publish(publishRequest);
      assert.equal(publication.status, 'created');
      assert.deepEqual(await service.publish(publishRequest), {
        status: 'existing',
        publication: publication.publication,
        authorization: publication.authorization,
      });
      await assert.rejects(
        service.transition({
          ...activateRequest,
          principal: principal('integration-publisher'),
        }),
        ModelPriceCatalogManagementSeparationOfDutyError,
      );
      const activation = await service.transition(activateRequest);
      assert.equal(activation.head.activePriceRevision, 'price-1');
      assert.equal(
        activation.authorization.principal.subject.id,
        'integration-reviewer',
      );
      assert.deepEqual(
        await repository.findAuthorization(activateRequest.authorizationId),
        activation.authorization,
      );

      const runtimePrivileges = await runtimePool.query(
        `SELECT
           has_table_privilege(
             current_user,
             'ql3_ai.model_price_catalog_authorizations',
             'SELECT'
           ) AS authorization_select,
           has_table_privilege(
             current_user,
             'ql3_ai.model_price_catalog_authorizations',
             'INSERT'
           ) AS authorization_insert`,
      );
      assert.deepEqual(runtimePrivileges.rows[0], {
        authorization_select: false,
        authorization_insert: false,
      });
      const adminPrivileges = await adminPool.query(
        `SELECT
           has_table_privilege(
             current_user,
             'ql3_ai.model_price_catalog_authorizations',
             'SELECT'
           ) AND
           has_table_privilege(
             current_user,
             'ql3_ai.model_price_catalog_authorizations',
             'INSERT'
           ) AS authorization_append,
           NOT has_table_privilege(
             current_user,
             'ql3_ai.model_price_catalog_authorizations',
             'UPDATE'
           ) AND NOT
           has_table_privilege(
             current_user,
             'ql3_ai.model_price_catalog_authorizations',
             'DELETE'
           ) AS authorization_no_rewrite`,
      );
      assert.deepEqual(adminPrivileges.rows[0], {
        authorization_append: true,
        authorization_no_rewrite: true,
      });
      await assertSqlState(
        runtimePool.query(
          `SELECT authorization_id
             FROM "ql3_ai"."model_price_catalog_authorizations"
            LIMIT 1`,
        ),
        '42501',
      );
      await assertSqlState(
        adminPool.query(
          `UPDATE "ql3_ai"."model_price_catalog_authorizations"
              SET operation = operation
            WHERE authorization_id = $1`,
          [activation.authorization.authorizationId],
        ),
        '42501',
      );
    } finally {
      await runtimePool.end();
      await adminPool.end();
      await migrationPool.end();
    }
  });
}
