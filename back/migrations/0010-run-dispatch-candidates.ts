import { createHash } from 'crypto';
import { Op } from 'sequelize';
import { RUN_ATTEMPT_TABLE, RUN_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const RUN_DISPATCH_CANDIDATE_RUN_INDEX = 'runs_dispatch_candidates_idx';
export const RUN_DISPATCH_CANDIDATE_ATTEMPT_INDEX =
  'run_attempts_dispatch_candidates_idx';

const manifest = {
  indexes: [
    `${RUN_DISPATCH_CANDIDATE_RUN_INDEX}(priority DESC,queued_at_ms,id) WHERE runtime queued/dispatching uncancelled`,
    `${RUN_DISPATCH_CANDIDATE_ATTEMPT_INDEX}(status,run_id,created_at_ms,id)`,
  ],
};

export const runDispatchCandidateManifest = manifest;

export const runDispatchCandidateMigration: Migration = {
  id: '0010-run-dispatch-candidates',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.addIndex(RUN_TABLE, {
      fields: [{ name: 'priority', order: 'DESC' }, 'queued_at_ms', 'id'],
      name: RUN_DISPATCH_CANDIDATE_RUN_INDEX,
      where: {
        execution_owner: 'runtime',
        status: { [Op.in]: ['queued', 'dispatching'] },
        cancel_requested_at_ms: null,
        queued_at_ms: { [Op.ne]: null },
      },
      transaction,
    });
    await queryInterface.addIndex(
      RUN_ATTEMPT_TABLE,
      ['status', 'run_id', 'created_at_ms', 'id'],
      { name: RUN_DISPATCH_CANDIDATE_ATTEMPT_INDEX, transaction },
    );
  },
};
