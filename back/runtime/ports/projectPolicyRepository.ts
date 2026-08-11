import type {
  PolicySubject,
  ProjectPolicySnapshot,
  ProjectRoleBindingRecord,
} from '../domain/projectPolicy';

export interface AppendProjectRoleBindingCommand {
  expectedCurrentVersion: number;
  binding: ProjectRoleBindingRecord;
}

export interface AppendProjectRoleBindingResult {
  status: 'inserted' | 'existing';
  binding: Readonly<ProjectRoleBindingRecord>;
}

export interface ProjectPolicyRepository {
  resolve(
    projectId: string,
    subject: Readonly<PolicySubject>,
  ): Promise<Readonly<ProjectPolicySnapshot> | null>;

  append(
    command: AppendProjectRoleBindingCommand,
  ): Promise<AppendProjectRoleBindingResult>;
}
