export class LocalDeploymentConfigurationError extends TypeError {
  readonly code = 'QL3_LOCAL_DEPLOYMENT_CONFIGURATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local deployment configuration is invalid: ${message}`, options);
    this.name = 'LocalDeploymentConfigurationError';
  }
}
