require('ts-node/register/transpile-only');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  registerRunRepositoryContract,
} = require('../../../test/contracts/runRepositoryContract.cjs');
const {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  RunEventPayloadTooLargeError,
} = require('@qinglong/runtime-core');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

registerRunRepositoryContract({
  name: 'Node SQLite local Profile binding',
  defaultExecutionOwner: 'runtime',
  contract: {
    DuplicateIdempotencyKeyError,
    DuplicateRunAttemptError,
    DuplicateRunEventError,
    RunEventPayloadTooLargeError,
    MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
    MAX_RUN_EVENT_PAGE_SIZE,
    MAX_RUN_EVENT_PAYLOAD_BYTES,
  },
  async createRepository() {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ql3-local-repository-contract-'),
    );
    const options = {
      databasePath: path.join(directory, 'qinglong3.sqlite'),
      profile: 'edge',
    };
    await migrateLocalSqlitePath(options);
    const runtime = await openLocalSqliteRuntimeDatabase(options);
    return {
      repository: runtime.runRepository,
      async close() {
        try {
          await runtime.close();
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  },
});
