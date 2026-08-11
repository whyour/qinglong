import type { ArtifactReadSubject } from '../domain/artifactRead';

export type ArtifactReadAuthorizationEffect =
  | 'allow'
  | 'deny'
  | 'require_approval';

export interface ArtifactReadAuthorizationRequest {
  action: 'artifact.read';
  subject: Readonly<ArtifactReadSubject>;
  projectId: string;
  runId: string;
  logArtifactId: string;
}

export interface ArtifactReadAuthorizer {
  authorize(
    request: Readonly<ArtifactReadAuthorizationRequest>,
  ): Promise<ArtifactReadAuthorizationEffect>;
}
