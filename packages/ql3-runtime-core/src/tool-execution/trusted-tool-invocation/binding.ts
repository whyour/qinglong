import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';
import {
  normalizeProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshotEntry,
} from '../tool-registry/projectToolDefinitionSnapshot';
import { ToolDefinitionRegistry } from '../tool-registry/toolRegistry';
import {
  MAX_TRUSTED_TOOL_HANDLER_BINDINGS,
  TRUSTED_TOOL_HANDLER_BINDING_SCHEMA,
  TRUSTED_TOOL_EXECUTION_CLASSES,
  TrustedToolHandlerUnavailableError,
  TrustedToolInvocationBindingConflictError,
  type CreateTrustedToolHandlerBindingInput,
  type TrustedToolHandlerBinding,
} from './contracts';
import {
  BINDING_DIGEST_DOMAIN,
  dataRecord,
  digest,
  exactKeys,
  hash,
  invalid,
  normalizeAuthorities,
  normalizeContractIdentity,
  normalizeProfile,
  normalizeProfiles,
  normalizeToolIdentity,
  positiveInteger,
} from './codec';

function definitionEntry(
  snapshot: Readonly<ProjectToolDefinitionSnapshot>,
  tool: Readonly<{ name: string; version: string }>,
): Readonly<ProjectToolDefinitionSnapshotEntry> {
  const entry = snapshot.definitions.find(
    (candidate) =>
      candidate.definition.name === tool.name &&
      candidate.definition.version === tool.version,
  );
  if (!entry) throw new TrustedToolHandlerUnavailableError();
  return entry;
}

function bindingWithoutDigest(
  value: Readonly<TrustedToolHandlerBinding>,
): Omit<TrustedToolHandlerBinding, 'bindingDigest'> {
  const { bindingDigest: _bindingDigest, ...unsigned } = value;
  return unsigned;
}

function normalizeBindingUnsigned(
  value: Omit<TrustedToolHandlerBinding, 'bindingDigest'>,
): Omit<TrustedToolHandlerBinding, 'bindingDigest'> {
  const record = dataRecord(value, 'handler binding');
  exactKeys(
    record,
    [
      'adapter',
      'auditContract',
      'authorities',
      'definitionDigest',
      'executionClass',
      'profiles',
      'redactionContract',
      'schema',
      'snapshotDigest',
      'timeoutSeconds',
      'tool',
    ],
    [],
    'handler binding',
  );
  if (
    value.schema !== TRUSTED_TOOL_HANDLER_BINDING_SCHEMA ||
    !TRUSTED_TOOL_EXECUTION_CLASSES.includes(value.executionClass)
  ) {
    return invalid('handler binding schema or execution class is invalid');
  }
  return Object.freeze({
    schema: TRUSTED_TOOL_HANDLER_BINDING_SCHEMA,
    snapshotDigest: digest(value.snapshotDigest, 'snapshot digest'),
    definitionDigest: digest(value.definitionDigest, 'definition digest'),
    tool: normalizeToolIdentity(value.tool, 'handler Tool'),
    adapter: normalizeContractIdentity(value.adapter, 'handler adapter'),
    executionClass: value.executionClass,
    profiles: normalizeProfiles(value.profiles),
    authorities: normalizeAuthorities(value.authorities),
    timeoutSeconds: positiveInteger(
      value.timeoutSeconds,
      60 * 60,
      'handler timeout',
    ),
    redactionContract: normalizeContractIdentity(
      value.redactionContract,
      'redaction contract',
    ),
    auditContract: normalizeContractIdentity(
      value.auditContract,
      'audit contract',
    ),
  });
}

export function normalizeTrustedToolHandlerBinding(
  value: TrustedToolHandlerBinding,
): Readonly<TrustedToolHandlerBinding> {
  const record = dataRecord(value, 'handler binding');
  exactKeys(
    record,
    [
      'adapter',
      'auditContract',
      'authorities',
      'bindingDigest',
      'definitionDigest',
      'executionClass',
      'profiles',
      'redactionContract',
      'schema',
      'snapshotDigest',
      'timeoutSeconds',
      'tool',
    ],
    [],
    'handler binding',
  );
  const unsigned = normalizeBindingUnsigned(bindingWithoutDigest(value));
  const bindingDigest = digest(value.bindingDigest, 'binding digest');
  if (hash(BINDING_DIGEST_DOMAIN, unsigned) !== bindingDigest) {
    return invalid('handler binding digest does not match');
  }
  return Object.freeze({ ...unsigned, bindingDigest });
}

export function createTrustedToolHandlerBinding(
  snapshotValue: ProjectToolDefinitionSnapshot,
  inputValue: CreateTrustedToolHandlerBindingInput,
): Readonly<TrustedToolHandlerBinding> {
  const snapshot = normalizeProjectToolDefinitionSnapshot(snapshotValue);
  const input = dataRecord(inputValue, 'handler binding input');
  exactKeys(
    input,
    [
      'adapter',
      'auditContract',
      'authorities',
      'executionClass',
      'profiles',
      'redactionContract',
      'timeoutSeconds',
      'tool',
    ],
    [],
    'handler binding input',
  );
  const tool = normalizeToolIdentity(inputValue.tool, 'handler Tool');
  const entry = definitionEntry(snapshot, tool);
  const unsigned = normalizeBindingUnsigned({
    schema: TRUSTED_TOOL_HANDLER_BINDING_SCHEMA,
    snapshotDigest: snapshot.snapshotDigest,
    definitionDigest: entry.definitionDigest,
    tool,
    adapter: inputValue.adapter,
    executionClass: inputValue.executionClass,
    profiles: inputValue.profiles,
    authorities: inputValue.authorities,
    timeoutSeconds: inputValue.timeoutSeconds,
    redactionContract: inputValue.redactionContract,
    auditContract: inputValue.auditContract,
  });
  if (unsigned.timeoutSeconds > entry.definition.timeoutSeconds) {
    return invalid('handler timeout widens the Tool definition timeout');
  }
  return Object.freeze({
    ...unsigned,
    bindingDigest: hash(BINDING_DIGEST_DOMAIN, unsigned),
  });
}

function toolKey(tool: Readonly<{ name: string; version: string }>): string {
  return `${tool.name}@${tool.version}`;
}

export class TrustedToolHandlerBindingRegistry {
  readonly #snapshot: Readonly<ProjectToolDefinitionSnapshot>;
  readonly #bindings: ReadonlyMap<string, Readonly<TrustedToolHandlerBinding>>;
  readonly #metadata: readonly Readonly<TrustedToolHandlerBinding>[];

  constructor(
    snapshotValue: ProjectToolDefinitionSnapshot,
    bindingValues: readonly TrustedToolHandlerBinding[],
  ) {
    const snapshot = normalizeProjectToolDefinitionSnapshot(snapshotValue);
    if (
      !Array.isArray(bindingValues) ||
      bindingValues.length > MAX_TRUSTED_TOOL_HANDLER_BINDINGS
    ) {
      invalid('handler binding count is invalid');
    }
    const bindings = new Map<string, Readonly<TrustedToolHandlerBinding>>();
    for (const bindingValue of bindingValues) {
      const binding = normalizeTrustedToolHandlerBinding(bindingValue);
      const entry = definitionEntry(snapshot, binding.tool);
      if (
        binding.snapshotDigest !== snapshot.snapshotDigest ||
        binding.definitionDigest !== entry.definitionDigest ||
        binding.timeoutSeconds > entry.definition.timeoutSeconds
      ) {
        throw new TrustedToolInvocationBindingConflictError();
      }
      const key = toolKey(binding.tool);
      if (bindings.has(key)) {
        invalid('handler binding is duplicated');
      }
      bindings.set(key, binding);
    }
    this.#snapshot = snapshot;
    this.#bindings = bindings;
    this.#metadata = Object.freeze(
      [...bindings.values()].sort((left, right) =>
        toolKey(left.tool).localeCompare(toolKey(right.tool)),
      ),
    );
    Object.freeze(this);
  }

  get projectId(): string {
    return this.#snapshot.projectId;
  }

  get snapshotDigest(): string {
    return this.#snapshot.snapshotDigest;
  }

  list(): readonly Readonly<TrustedToolHandlerBinding>[] {
    return this.#metadata;
  }

  resolve(
    name: string,
    version: string,
    profile: DeploymentProfile,
  ): Readonly<TrustedToolHandlerBinding> {
    const normalizedProfile = normalizeProfile(profile);
    const binding = this.#bindings.get(toolKey({ name, version }));
    if (!binding || !binding.profiles.includes(normalizedProfile)) {
      throw new TrustedToolHandlerUnavailableError();
    }
    return binding;
  }

  definitionRegistry(): ToolDefinitionRegistry {
    return new ToolDefinitionRegistry(
      this.#snapshot.definitions.map((entry) => entry.definition),
    );
  }
}
