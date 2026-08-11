const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackageAutomationPublicationUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  PostgresPluginPackageAutomationPublicationRepository,
} = require('../dist/plugin-package/publication/pluginPackageAutomationPublicationRepository');

const PROJECT_ID = 'automation-project';
const PACKAGE_NAME = 'automation-package';
const PUBLICATION_DIGEST = 'a'.repeat(64);

function pool(query) {
  return {
    query,
    async connect() {
      throw new Error('transaction client is not expected');
    },
  };
}

test('delegates the exact automation start decision to the database guard', async () => {
  const queries = [];
  const repository =
    new PostgresPluginPackageAutomationPublicationRepository(pool(
      async (text, values) => {
        queries.push({ text, values });
        return { rows: [{ allowed: true }] };
      },
    ));

  assert.equal(
    await repository.isStartAllowed(
      PROJECT_ID,
      PACKAGE_NAME,
      PUBLICATION_DIGEST,
    ),
    true,
  );
  assert.equal(queries.length, 1);
  assert.match(
    queries[0].text,
    /"ql3"\."plugin_package_automation_start_allowed"/,
  );
  assert.deepEqual(queries[0].values, [
    PROJECT_ID,
    PACKAGE_NAME,
    PUBLICATION_DIGEST,
  ]);
});

test('fails closed when the database guard returns a malformed decision', async () => {
  const repository =
    new PostgresPluginPackageAutomationPublicationRepository(pool(
      async () => {
        return { rows: [{ allowed: 1 }] };
      },
    ));

  await assert.rejects(
    repository.isStartAllowed(
      PROJECT_ID,
      PACKAGE_NAME,
      PUBLICATION_DIGEST,
    ),
    PluginPackageAutomationPublicationUnavailableError,
  );
});

test('excludes quarantined and publisher-revoked generations from recovery', async () => {
  let recoverySql = '';
  const repository =
    new PostgresPluginPackageAutomationPublicationRepository(pool(
      async (text) => {
        recoverySql = text;
        return { rows: [] };
      },
    ));

  assert.deepEqual(await repository.listPendingPage({ limit: 1 }), {
    candidates: [],
    truncated: false,
  });
  assert.match(recoverySql, /plugin_package_quarantine_events/);
  assert.match(recoverySql, /plugin_package_publisher_provenance/);
  assert.match(recoverySql, /plugin_package_publisher_revocation_receipts/);
});
