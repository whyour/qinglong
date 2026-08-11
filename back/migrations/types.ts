import type { QueryInterface, Transaction } from 'sequelize';

export interface MigrationContext {
  queryInterface: QueryInterface;
  transaction: Transaction;
}

export interface Migration {
  id: string;
  checksum: string;
  up(context: MigrationContext): Promise<void>;
}
