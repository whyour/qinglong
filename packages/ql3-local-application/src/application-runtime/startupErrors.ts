import type { PluginPackageRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-recovery';
import type { PluginPackageAutomationPublicationRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { PluginPackageTaskPublicationRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-task-publication';
import type { ProjectToolDefinitionSnapshotRecoveryCycleResult } from '@qinglong/runtime-core/project-tool-definition-snapshot';

export class LocalApplicationStartupRecoveryRequiredError extends Error {
  constructor(
    readonly observedCandidates: number,
    readonly truncated: boolean,
  ) {
    super('Local application has unresolved startup recovery candidates');
    this.name = 'LocalApplicationStartupRecoveryRequiredError';
  }
}

export class LocalApplicationPluginPackageRecoveryRequiredError extends Error {
  constructor(readonly recovery: Readonly<PluginPackageRecoveryCycleResult>) {
    super('Local application has unresolved Plugin Package recovery work');
    this.name = 'LocalApplicationPluginPackageRecoveryRequiredError';
  }
}

export class LocalApplicationPluginPackageTaskPublicationRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<PluginPackageTaskPublicationRecoveryCycleResult>,
  ) {
    super(
      'Local application has unresolved Plugin Package Task publication work',
    );
    this.name = 'LocalApplicationPluginPackageTaskPublicationRequiredError';
  }
}

export class LocalApplicationPluginPackageAutomationPublicationRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>,
  ) {
    super(
      'Local application has unresolved Plugin Package Workflow/Prompt publication work',
    );
    this.name =
      'LocalApplicationPluginPackageAutomationPublicationRequiredError';
  }
}

export class LocalApplicationPluginPackageToolSnapshotRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>,
  ) {
    super('Local application has unresolved Plugin Package Tool snapshot work');
    this.name = 'LocalApplicationPluginPackageToolSnapshotRequiredError';
  }
}
