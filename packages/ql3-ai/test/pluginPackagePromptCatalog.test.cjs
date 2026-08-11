const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPluginPackagePromptCatalogResult,
  PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA,
} = require('../dist/prompt/pluginPackagePromptCatalog.js');
const {
  PostgresPluginPackagePromptCatalogService,
} = require('../dist/prompt/postgresPluginPackagePromptApplication.js');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function publication() {
  const source = pluginPackageTaskReconciliationFixture('prompt-catalog', {
    profile: 'cluster-control',
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'summary',
        name: 'Summary',
        description: 'Summarizes input',
        template: 'Private template {{subject}}.',
        parameters: [
          {
            name: 'subject',
            description: 'Text to summarize',
            required: true,
          },
        ],
      },
    ],
  });
  return createInitialPluginPackageAutomationPublication(
    source.revision,
    source.registry,
    20_000,
  );
}

test('catalog projection excludes Prompt template content', () => {
  const current = publication();
  const result = createPluginPackagePromptCatalogResult(
    current.target.projectId,
    current.target.packageName,
    current,
  );
  assert.equal(result.schema, PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA);
  assert.deepEqual(result.prompts, [
    {
      id: 'summary',
      name: 'Summary',
      description: 'Summarizes input',
      parameters: [
        {
          name: 'subject',
          description: 'Text to summarize',
          required: true,
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(result).includes('Private template'), false);
});

test('PostgreSQL catalog reads one current publication and returns empty for absence', async () => {
  const current = publication();
  const queries = [];
  const service = new PostgresPluginPackagePromptCatalogService({
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [{ publicationJson: current }] };
    },
  });
  const result = await service.inspect(
    current.target.projectId,
    current.target.packageName,
  );
  assert.equal(result.found, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /LIMIT 2/);

  const absent = new PostgresPluginPackagePromptCatalogService({
    async query() {
      return { rows: [] };
    },
  });
  assert.deepEqual(
    await absent.inspect(current.target.projectId, current.target.packageName),
    {
      schema: PLUGIN_PACKAGE_PROMPT_CATALOG_SCHEMA,
      projectId: current.target.projectId,
      packageName: current.target.packageName,
      found: false,
      publicationState: null,
      prompts: [],
    },
  );
});
