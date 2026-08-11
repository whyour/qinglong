import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import { RUN_ATTEMPT_TABLE, RUN_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const COMPLETION_RECEIPT_JOURNAL_TABLE = 'CompletionReceiptJournals';
export const COMPLETION_RECEIPT_JOURNAL_SCAN_INDEX =
  'completion_receipt_journal_scan_idx';
export const COMPLETION_RECEIPT_JOURNAL_PURGE_INDEX =
  'completion_receipt_journal_purge_idx';

const manifest = {
  table: COMPLETION_RECEIPT_JOURNAL_TABLE,
  columns: [
    'attempt_id',
    'run_id',
    'state',
    'quarantine_ref',
    'purge_after_ms',
    'registered_at_ms',
    'updated_at_ms',
  ],
  indexes: [
    `${COMPLETION_RECEIPT_JOURNAL_SCAN_INDEX}(state,updated_at_ms,attempt_id)`,
    `${COMPLETION_RECEIPT_JOURNAL_PURGE_INDEX}(state,purge_after_ms,attempt_id)`,
  ],
  constraints: [
    'completion_receipt_journal_state_check',
    'completion_receipt_journal_registered_nonnegative_check',
    'completion_receipt_journal_updated_nonnegative_check',
  ],
};

export const completionReceiptJournalManifest = manifest;

export const completionReceiptJournalMigration: Migration = {
  id: '0007-completion-receipt-journal',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      COMPLETION_RECEIPT_JOURNAL_TABLE,
      {
        attempt_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          primaryKey: true,
          references: { model: RUN_ATTEMPT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        run_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        state: {
          type: DataTypes.STRING(16),
          allowNull: false,
          defaultValue: 'pending',
        },
        quarantine_ref: { type: DataTypes.STRING(255), allowNull: true },
        purge_after_ms: { type: DataTypes.BIGINT, allowNull: true },
        registered_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(COMPLETION_RECEIPT_JOURNAL_TABLE, {
      fields: ['state'],
      type: 'check',
      where: { state: { [Op.in]: ['pending', 'quarantined'] } },
      name: 'completion_receipt_journal_state_check',
      transaction,
    });
    await queryInterface.addConstraint(COMPLETION_RECEIPT_JOURNAL_TABLE, {
      fields: ['registered_at_ms'],
      type: 'check',
      where: { registered_at_ms: { [Op.gte]: 0 } },
      name: 'completion_receipt_journal_registered_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(COMPLETION_RECEIPT_JOURNAL_TABLE, {
      fields: ['updated_at_ms'],
      type: 'check',
      where: { updated_at_ms: { [Op.gte]: 0 } },
      name: 'completion_receipt_journal_updated_nonnegative_check',
      transaction,
    });
    await queryInterface.addIndex(
      COMPLETION_RECEIPT_JOURNAL_TABLE,
      ['state', 'updated_at_ms', 'attempt_id'],
      { name: COMPLETION_RECEIPT_JOURNAL_SCAN_INDEX, transaction },
    );
    await queryInterface.addIndex(
      COMPLETION_RECEIPT_JOURNAL_TABLE,
      ['state', 'purge_after_ms', 'attempt_id'],
      { name: COMPLETION_RECEIPT_JOURNAL_PURGE_INDEX, transaction },
    );
  },
};
