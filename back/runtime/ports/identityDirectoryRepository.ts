import type { PolicySubject } from '../domain/projectPolicy';

export interface IdentityDirectoryRepository {
  resolveAuthenticationSubject(
    provider: string,
    providerSubject: string,
  ): Promise<Readonly<PolicySubject> | null>;
}
