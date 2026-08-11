import type {
  LocalSecretEnvelope,
  LocalSecretReference,
} from '../domain/localSecret';

export interface AppendLocalSecretEnvelopeCommand {
  envelope: LocalSecretEnvelope;
  expectedCurrentVersion: number;
}

export type AppendLocalSecretEnvelopeResult =
  | { status: 'inserted'; envelope: LocalSecretEnvelope }
  | { status: 'existing'; envelope: LocalSecretEnvelope };

export interface LocalSecretEnvelopeRepository {
  append(
    command: AppendLocalSecretEnvelopeCommand,
  ): Promise<AppendLocalSecretEnvelopeResult>;
  findByMutation(
    projectId: string,
    name: string,
    mutationId: string,
  ): Promise<LocalSecretEnvelope | null>;
  resolveMany(
    references: readonly LocalSecretReference[],
  ): Promise<readonly (LocalSecretEnvelope | null)[]>;
}
