export class InvalidPluginPackageWorkflowAdministrationMutationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_MUTATION_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package Workflow administration mutation is invalid: ${message}`,
    );
    this.name = 'InvalidPluginPackageWorkflowAdministrationMutationError';
  }
}

export class PluginPackageWorkflowAdministrationAuthorizationFenceConflictError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Plugin Package Workflow administration authorization fence changed');
    this.name =
      'PluginPackageWorkflowAdministrationAuthorizationFenceConflictError';
  }
}

export class PluginPackageWorkflowAdministrationMutationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_MUTATION_CONFLICT';

  constructor() {
    super(
      'Plugin Package Workflow administration conflicts with durable state',
    );
    this.name = 'PluginPackageWorkflowAdministrationMutationConflictError';
  }
}

export class PluginPackageWorkflowCancellationNotFoundError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_NOT_FOUND';

  constructor() {
    super('Plugin Package Workflow cancellation target does not exist');
    this.name = 'PluginPackageWorkflowCancellationNotFoundError';
  }
}
