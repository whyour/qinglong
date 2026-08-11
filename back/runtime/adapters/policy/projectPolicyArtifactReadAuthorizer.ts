import type { ArtifactReadAuthorizer } from '../../ports/artifactReadAuthorizer';
import type { ArtifactReadAuthorizationEffect } from '../../ports/artifactReadAuthorizer';
import type { ProjectPolicyEngine } from '../../application/projectPolicyEngine';

export class ProjectPolicyArtifactReadAuthorizer
  implements ArtifactReadAuthorizer
{
  constructor(private readonly policy: Pick<ProjectPolicyEngine, 'decide'>) {}

  async authorize(
    request: Parameters<ArtifactReadAuthorizer['authorize']>[0],
  ): Promise<ArtifactReadAuthorizationEffect> {
    if (request.action !== 'artifact.read') {
      throw new TypeError('Artifact read authorization action is invalid');
    }
    const result = await this.policy.decide({
      subject: request.subject,
      projectId: request.projectId,
      permission: 'artifact.read',
    });
    return result.effect;
  }
}
