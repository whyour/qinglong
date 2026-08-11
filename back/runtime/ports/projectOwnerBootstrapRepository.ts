import type {
  PolicySubject,
  ProjectRoleBindingRecord,
} from '../domain/projectPolicy';
import type { ProjectOwnerBootstrapChallengeRecord } from '../domain/projectOwnerBootstrap';

export interface IssueProjectOwnerBootstrapChallengeCommand {
  projectId: string;
  challengeId: string;
  tokenDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface ClaimProjectOwnerBootstrapChallengeCommand {
  projectId: string;
  challengeId: string;
  tokenDigest: string;
  subject: PolicySubject;
  claimedAtMs: number;
}

export interface ClaimProjectOwnerBootstrapChallengeResult {
  status: 'claimed' | 'existing';
  binding: Readonly<ProjectRoleBindingRecord>;
}

export interface ProjectOwnerBootstrapRepository {
  issue(
    command: IssueProjectOwnerBootstrapChallengeCommand,
  ): Promise<Readonly<ProjectOwnerBootstrapChallengeRecord>>;

  claim(
    command: ClaimProjectOwnerBootstrapChallengeCommand,
  ): Promise<ClaimProjectOwnerBootstrapChallengeResult>;
}
