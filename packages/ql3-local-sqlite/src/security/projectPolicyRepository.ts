import type { DatabaseSync } from 'node:sqlite';

import type {
  AppendProjectRoleBindingCommand,
  AppendProjectRoleBindingResult,
  ProjectPolicyRepository,
  ProjectPolicySnapshot,
} from '@qinglong/runtime-core/project-policy';
import type { SecuritySubject } from '@qinglong/runtime-core/security';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteSecurityAuthorityStore } from './securityAuthorityStore';

export class LocalSqliteProjectPolicyRepository
  implements ProjectPolicyRepository
{
  readonly #store: LocalSqliteSecurityAuthorityStore;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#store = new LocalSqliteSecurityAuthorityStore(
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority),
    );
  }

  resolve(
    projectId: string,
    subject: Readonly<SecuritySubject>,
  ): Promise<Readonly<ProjectPolicySnapshot> | null> {
    return this.#store.resolve(projectId, subject);
  }

  append(
    command: AppendProjectRoleBindingCommand,
  ): Promise<AppendProjectRoleBindingResult> {
    return this.#store.append(command);
  }
}
