import { QueryTypes, Sequelize } from 'sequelize';
import {
  IDENTITY_AUTHENTICATION_BINDING_TABLE,
  IDENTITY_SUBJECT_TABLE,
} from '../../../migrations/0019-identity-directory';
import {
  IdentityDirectoryUnavailableError,
  assertIdentityProvider,
  assertIdentityProviderSubject,
  normalizeIdentityAuthenticationBindingRecord,
  normalizeIdentitySubjectRecord,
} from '../../domain/identityDirectory';
import type { PolicySubject } from '../../domain/projectPolicy';
import type { IdentityDirectoryRepository } from '../../ports/identityDirectoryRepository';

interface IdentityAuthenticationRow {
  provider: string;
  provider_subject: string;
  binding_version: number;
  binding_state: string;
  binding_subject_id: string;
  binding_created_at_ms: number | string;
  subject_id: string | null;
  subject_type: string | null;
  subject_status: string | null;
  subject_version: number | null;
  subject_created_at_ms: number | string | null;
  subject_updated_at_ms: number | string | null;
}

export class LegacySequelizeIdentityDirectoryRepository
  implements IdentityDirectoryRepository
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Identity directory repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async resolveAuthenticationSubject(
    provider: string,
    providerSubject: string,
  ): Promise<Readonly<PolicySubject> | null> {
    assertIdentityProvider(provider);
    assertIdentityProviderSubject(providerSubject);
    try {
      const rows = await this.database.query<IdentityAuthenticationRow>(
        `SELECT binding.provider AS provider,
                binding.provider_subject AS provider_subject,
                binding.version AS binding_version,
                binding.state AS binding_state,
                binding.subject_id AS binding_subject_id,
                binding.created_at_ms AS binding_created_at_ms,
                subject.id AS subject_id,
                subject.type AS subject_type,
                subject.status AS subject_status,
                subject.version AS subject_version,
                subject.created_at_ms AS subject_created_at_ms,
                subject.updated_at_ms AS subject_updated_at_ms
           FROM "${IDENTITY_AUTHENTICATION_BINDING_TABLE}" AS binding
      LEFT JOIN "${IDENTITY_SUBJECT_TABLE}" AS subject
             ON subject.id = binding.subject_id
          WHERE binding.provider = :provider
            AND binding.provider_subject = :providerSubject
            AND binding.version = (
              SELECT MAX(current.version)
                FROM "${IDENTITY_AUTHENTICATION_BINDING_TABLE}" AS current
               WHERE current.provider = binding.provider
                 AND current.provider_subject = binding.provider_subject
            )
          LIMIT 2`,
        {
          type: QueryTypes.SELECT,
          replacements: { provider, providerSubject },
        },
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new IdentityDirectoryUnavailableError();
      const row = rows[0];
      const binding = normalizeIdentityAuthenticationBindingRecord({
        provider: row.provider,
        providerSubject: row.provider_subject,
        version: Number(row.binding_version),
        state: row.binding_state as 'active' | 'revoked',
        subjectId: row.binding_subject_id,
        createdAtMs: Number(row.binding_created_at_ms),
      });
      const subject = normalizeIdentitySubjectRecord({
        subject: {
          type: row.subject_type as PolicySubject['type'],
          id: row.subject_id!,
        },
        status: row.subject_status as 'active' | 'disabled',
        version: Number(row.subject_version),
        createdAtMs: Number(row.subject_created_at_ms),
        updatedAtMs: Number(row.subject_updated_at_ms),
      });
      if (binding.subjectId !== subject.subject.id) {
        throw new IdentityDirectoryUnavailableError();
      }
      if (
        binding.state !== 'active' ||
        subject.status !== 'active' ||
        subject.subject.type !== 'user'
      ) {
        return null;
      }
      return subject.subject;
    } catch (error) {
      if (error instanceof IdentityDirectoryUnavailableError) throw error;
      throw new IdentityDirectoryUnavailableError();
    }
  }
}
