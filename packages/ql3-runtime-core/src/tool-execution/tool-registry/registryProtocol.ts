import { semver } from '../../versioning/pinnedSemver';
import {
  InvalidToolDefinitionError,
  InvalidToolJsonValueError,
  MAX_TOOL_DEFINITIONS,
  MAX_TOOL_INPUT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  UnsupportedToolError,
  type ToolDefinition,
  type ToolJsonSchema,
  type ToolJsonValue,
} from './contracts';
import { normalizeToolDefinition } from './definitionProtocol';

function valueRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidToolJsonValueError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidToolJsonValueError(`${label} must be a plain JSON object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined,
    )
  ) {
    throw new InvalidToolJsonValueError(
      `${label} must contain only JSON data properties`,
    );
  }
  return value as Record<string, unknown>;
}

function normalizeJson(
  value: unknown,
  schema: ToolJsonSchema,
  path: string,
): ToolJsonValue {
  if (schema.type === 'null') {
    if (value !== null) {
      throw new InvalidToolJsonValueError(`${path} must be null`);
    }
    return null;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new InvalidToolJsonValueError(`${path} must be boolean`);
    }
    return value;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      throw new InvalidToolJsonValueError(`${path} must be a string`);
    }
    const length = Array.from(value).length;
    if (
      length > schema.maxLength ||
      (schema.minLength !== undefined && length < schema.minLength) ||
      (schema.enum !== undefined && !schema.enum.includes(value))
    ) {
      throw new InvalidToolJsonValueError(`${path} violates its string bounds`);
    }
    return value;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER ||
      value < schema.minimum ||
      value > schema.maximum ||
      (schema.type === 'integer' && !Number.isSafeInteger(value))
    ) {
      throw new InvalidToolJsonValueError(
        `${path} violates its numeric bounds`,
      );
    }
    return value;
  }
  if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length > schema.maxItems ||
      (schema.minItems !== undefined && value.length < schema.minItems)
    ) {
      throw new InvalidToolJsonValueError(`${path} violates its array bounds`);
    }
    const enumerableKeys = Object.keys(value);
    if (
      enumerableKeys.length !== value.length ||
      enumerableKeys.some(
        (key, index) =>
          key !== String(index) ||
          !Object.hasOwn(value, index) ||
          !Object.hasOwn(
            Object.getOwnPropertyDescriptor(value, key) ?? {},
            'value',
          ),
      )
    ) {
      throw new InvalidToolJsonValueError(`${path} must be a dense JSON array`);
    }
    const normalized = value.map((item, index) =>
      normalizeJson(item, schema.items, `${path}[${index}]`),
    );
    if (schema.uniqueItems) {
      const identities = normalized.map((item) => JSON.stringify(item));
      if (new Set(identities).size !== identities.length) {
        throw new InvalidToolJsonValueError(`${path} contains duplicate items`);
      }
    }
    return Object.freeze(normalized);
  }

  const source = valueRecord(value, path);
  const keys = Object.keys(source);
  if (
    keys.some((key) => !Object.hasOwn(schema.properties, key)) ||
    schema.required.some((key) => !Object.hasOwn(source, key))
  ) {
    throw new InvalidToolJsonValueError(
      `${path} has missing or unknown properties`,
    );
  }
  const normalized: Record<string, ToolJsonValue> = {};
  for (const key of keys.sort()) {
    normalized[key] = normalizeJson(
      source[key],
      schema.properties[key]!,
      `${path}.${key}`,
    );
  }
  return Object.freeze(normalized);
}

function normalizeBoundedJson(
  value: unknown,
  schema: ToolJsonSchema,
  maximumBytes: number,
  label: string,
): ToolJsonValue {
  const normalized = normalizeJson(value, schema, label);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maximumBytes) {
    throw new InvalidToolJsonValueError(`${label} byte budget exceeded`);
  }
  return normalized;
}

function toolIdentity(name: string, version: string): string {
  return `${name}@${version}`;
}

export class ToolDefinitionRegistry {
  readonly #definitions: ReadonlyMap<string, Readonly<ToolDefinition>>;
  readonly #metadata: readonly Readonly<ToolDefinition>[];

  constructor(definitions: readonly unknown[]) {
    if (
      !Array.isArray(definitions) ||
      definitions.length > MAX_TOOL_DEFINITIONS
    ) {
      throw new InvalidToolDefinitionError(
        'registry definition count is invalid',
      );
    }
    const byIdentity = new Map<string, Readonly<ToolDefinition>>();
    for (const value of definitions) {
      const definition = normalizeToolDefinition(value);
      const identity = toolIdentity(definition.name, definition.version);
      if (byIdentity.has(identity)) {
        throw new InvalidToolDefinitionError(
          'registry definition is duplicated',
        );
      }
      byIdentity.set(identity, definition);
    }
    this.#definitions = byIdentity;
    this.#metadata = Object.freeze(
      [...byIdentity.values()].sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          semver().compare(left.version, right.version),
      ),
    );
    Object.freeze(this);
  }

  list(): readonly Readonly<ToolDefinition>[] {
    return this.#metadata;
  }

  resolve(name: string, version: string): Readonly<ToolDefinition> {
    const definition = this.#definitions.get(toolIdentity(name, version));
    if (!definition) throw new UnsupportedToolError();
    return definition;
  }

  normalizeInput(name: string, version: string, input: unknown): ToolJsonValue {
    const definition = this.resolve(name, version);
    return normalizeBoundedJson(
      input,
      definition.inputSchema,
      MAX_TOOL_INPUT_BYTES,
      'input',
    );
  }

  normalizeOutput(
    name: string,
    version: string,
    output: unknown,
  ): ToolJsonValue {
    const definition = this.resolve(name, version);
    if (definition.outputSchema === undefined) {
      if (output !== null) {
        throw new InvalidToolJsonValueError(
          'output must be null when outputSchema is absent',
        );
      }
      return null;
    }
    return normalizeBoundedJson(
      output,
      definition.outputSchema,
      MAX_TOOL_OUTPUT_BYTES,
      'output',
    );
  }
}
