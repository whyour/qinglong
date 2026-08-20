/** Bounded commands and low-sensitive product projections for Package installations. */
import { randomUUID } from 'node:crypto';

import type { ClusterPluginPackageManagementClientResult } from '../../management-support/pluginPackageManagementClient';
import type {
  ClusterPluginPackageManagementCommand,
  ClusterPluginPackageManagementTransportResult,
} from './pluginPackageManagementTransport';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PACKAGE_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,126}[0-9A-Za-z])?$/;
const PAGE_SIZE = 16;
const INSTALL_OPERATIONS = new Set([
  'install',
  'reinstall',
  'upgrade',
  'rollback',
]);
const INSTALL_STATES = new Set([
  'queued',
  'staged',
  'activating',
  'active',
  'failed',
]);
const RECOVERY_ACTIONS = new Set([
  'resume_stage',
  'resume_activation',
  'inspect_activation',
  'none',
]);
const AVAILABILITY = new Set(['active', 'not_active', 'quarantined']);
const FAILURE_REASONS = new Set([
  'source_unavailable',
  'source_mismatch',
  'stage_failed',
  'activation_failed',
  'activation_fact_conflict',
  'approval_expired',
  'policy_fence_changed',
  'resource_exhausted',
]);
const QUARANTINE_REASONS = new Set([
  'suspected_key_compromise',
  'confirmed_key_compromise',
]);

type InspectCommand = Extract<
  ClusterPluginPackageManagementCommand,
  { readonly operation: 'plugin-package.installation.inspect' }
>;
type ListCommand = Extract<
  ClusterPluginPackageManagementCommand,
  { readonly operation: 'plugin-package.installation.list' }
>;
type InspectResult = Extract<
  ClusterPluginPackageManagementTransportResult,
  { readonly operation: 'plugin-package.installation.inspect' }
>;
type ListResult = Extract<
  ClusterPluginPackageManagementTransportResult,
  { readonly operation: 'plugin-package.installation.list' }
>;
type Installation = NonNullable<InspectResult['installation']>;

export interface PluginPackageInstallationObservation {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly installOperation: Installation['operation'];
  readonly state: Installation['state'];
  readonly targetGeneration: number;
  readonly recoveryAction: Installation['recoveryAction'];
  readonly availability: Installation['availability'];
  readonly quarantineReason: Installation['quarantineReason'];
  readonly failureReason: Installation['failureReason'];
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface PluginPackageInstallationInspection {
  readonly schema: 'qinglong/plugin-package-installation-inspection@v1';
  readonly projectId: string;
  readonly packageName: string;
  readonly found: boolean;
  readonly installation: Readonly<PluginPackageInstallationObservation> | null;
}

export interface PluginPackageInstallationList {
  readonly schema: 'qinglong/plugin-package-installation-list@v1';
  readonly projectId: string;
  readonly count: number;
  readonly installations: readonly Readonly<PluginPackageInstallationObservation>[];
  readonly truncated: boolean;
  readonly nextAfterPackageName: string | null;
}

export class ClusterPluginPackageInstallationProductError extends TypeError {
  readonly code = 'QL3_PLUGIN_PACKAGE_INSTALLATION_PRODUCT_INPUT_INVALID';

  constructor() {
    super('Plugin Package installation product input is invalid');
    this.name = 'ClusterPluginPackageInstallationProductError';
  }
}

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new ClusterPluginPackageInstallationProductError();
  }
  return value;
}

function packageName(value: string): string {
  if (!PACKAGE_NAME.test(value)) {
    throw new ClusterPluginPackageInstallationProductError();
  }
  return value;
}

function packageVersion(value: string): string {
  if (!PACKAGE_VERSION.test(value)) {
    throw new ClusterPluginPackageInstallationProductError();
  }
  return value;
}

function enumValue<T extends string>(value: T, values: ReadonlySet<string>): T {
  if (!values.has(value)) {
    throw new ClusterPluginPackageInstallationProductError();
  }
  return value;
}

function nullableEnum<T extends string>(
  value: T | null,
  values: ReadonlySet<string>,
): T | null {
  return value === null ? null : enumValue(value, values);
}

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ClusterPluginPackageInstallationProductError();
  }
  return value;
}

function inspectionId(createId: () => string): string {
  return identifier(createId());
}

export function createPluginPackageInstallationInspectionCommand(
  projectId: string,
  name: string,
  createId: () => string = randomUUID,
): Readonly<InspectCommand> {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'plugin-package.installation.inspect',
    request: Object.freeze({
      projectId: identifier(projectId),
      packageName: packageName(name),
      inspectionId: inspectionId(createId),
    }),
  });
}

export function createPluginPackageInstallationListCommand(
  projectId: string,
  afterPackageName?: string,
  createId: () => string = randomUUID,
): Readonly<ListCommand> {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'plugin-package.installation.list',
    request: Object.freeze({
      projectId: identifier(projectId),
      limit: PAGE_SIZE,
      ...(afterPackageName === undefined
        ? {}
        : {
            after: Object.freeze({
              packageName: packageName(afterPackageName),
            }),
          }),
      inspectionId: inspectionId(createId),
    }),
  });
}

function projectInstallation(
  installation: Installation | ListResult['installations'][number],
): Readonly<PluginPackageInstallationObservation> {
  return Object.freeze({
    packageName: packageName(installation.packageName),
    packageVersion: packageVersion(installation.packageVersion),
    installOperation: enumValue(installation.operation, INSTALL_OPERATIONS),
    state: enumValue(installation.state, INSTALL_STATES),
    targetGeneration: safeInteger(installation.targetGeneration),
    recoveryAction: enumValue(installation.recoveryAction, RECOVERY_ACTIONS),
    availability: enumValue(installation.availability, AVAILABILITY),
    quarantineReason: nullableEnum(
      installation.quarantineReason,
      QUARANTINE_REASONS,
    ),
    failureReason: nullableEnum(installation.failureReason, FAILURE_REASONS),
    version: safeInteger(installation.version),
    createdAtMs: safeInteger(installation.createdAtMs),
    updatedAtMs: safeInteger(installation.updatedAtMs),
  });
}

export function projectPluginPackageInstallationInspection(
  projectId: string,
  name: string,
  response: Readonly<ClusterPluginPackageManagementClientResult>,
): Readonly<PluginPackageInstallationInspection> {
  if (response.result.operation !== 'plugin-package.installation.inspect') {
    throw new ClusterPluginPackageInstallationProductError();
  }
  const installation = response.result.installation;
  if (installation !== null && installation.packageName !== name) {
    throw new ClusterPluginPackageInstallationProductError();
  }
  return Object.freeze({
    schema: 'qinglong/plugin-package-installation-inspection@v1',
    projectId: identifier(projectId),
    packageName: packageName(name),
    found: installation !== null,
    installation:
      installation === null ? null : projectInstallation(installation),
  });
}

export function projectPluginPackageInstallationList(
  projectId: string,
  response: Readonly<ClusterPluginPackageManagementClientResult>,
): Readonly<PluginPackageInstallationList> {
  if (response.result.operation !== 'plugin-package.installation.list') {
    throw new ClusterPluginPackageInstallationProductError();
  }
  const installations = Object.freeze(
    response.result.installations.map(projectInstallation),
  );
  return Object.freeze({
    schema: 'qinglong/plugin-package-installation-list@v1',
    projectId: identifier(projectId),
    count: installations.length,
    installations,
    truncated: response.result.truncated,
    nextAfterPackageName: response.result.next?.packageName ?? null,
  });
}
