import {
  normalizeProjectPermission,
  type ProjectPermission,
} from '../../security/project-policy/projectPolicy';
import { semver } from '../../versioning/pinnedSemver';
import {
  InvalidToolDefinitionError,
  MAX_TOOL_ARRAY_ITEMS,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_REQUIRED_PERMISSIONS,
  MAX_TOOL_SCHEMA_DEPTH,
  MAX_TOOL_SCHEMA_ENUM_VALUES,
  MAX_TOOL_SCHEMA_NODES,
  MAX_TOOL_SCHEMA_PROPERTIES,
  MAX_TOOL_TIMEOUT_SECONDS,
  TOOL_EFFECTS,
  TOOL_JSON_SCHEMA_TYPES,
  TOOL_RISKS,
  type ToolDefinition,
  type ToolEffect,
  type ToolJsonSchema,
  type ToolJsonSchemaType,
  type ToolRisk,
} from './contracts';

const TOOL_NAME_PATTERN =
  /^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62}){1,7}$/;
const PROPERTY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function definitionRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidToolDefinitionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactDefinitionKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvalidToolDefinitionError(`${label} shape is invalid`);
  }
}

function boundedDefinitionText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidToolDefinitionError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new InvalidToolDefinitionError(`${label} is invalid`);
  }
  return value as number;
}

interface SchemaBudget {
  nodes: number;
}

function normalizeSchema(
  value: unknown,
  depth: number,
  budget: SchemaBudget,
): ToolJsonSchema {
  if (depth > MAX_TOOL_SCHEMA_DEPTH) {
    throw new InvalidToolDefinitionError('JSON Schema depth exceeded');
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_TOOL_SCHEMA_NODES) {
    throw new InvalidToolDefinitionError('JSON Schema node budget exceeded');
  }
  const schema = definitionRecord(value, 'JSON Schema');
  const type = schema.type;
  if (
    typeof type !== 'string' ||
    !TOOL_JSON_SCHEMA_TYPES.includes(type as ToolJsonSchemaType)
  ) {
    throw new InvalidToolDefinitionError('JSON Schema type is invalid');
  }
  if (type === 'null' || type === 'boolean') {
    exactDefinitionKeys(schema, ['type'], [], 'JSON Schema');
    return Object.freeze({ type });
  }
  if (type === 'string') {
    exactDefinitionKeys(
      schema,
      ['maxLength', 'type'],
      ['enum', 'minLength'],
      'string JSON Schema',
    );
    const maxLength = boundedInteger(
      schema.maxLength,
      0,
      MAX_TOOL_OUTPUT_BYTES,
      'string maxLength',
    );
    const minLength =
      schema.minLength === undefined
        ? undefined
        : boundedInteger(schema.minLength, 0, maxLength, 'string minLength');
    let values: readonly string[] | undefined;
    if (schema.enum !== undefined) {
      if (
        !Array.isArray(schema.enum) ||
        schema.enum.length < 1 ||
        schema.enum.length > MAX_TOOL_SCHEMA_ENUM_VALUES
      ) {
        throw new InvalidToolDefinitionError('string enum is invalid');
      }
      const unique = new Set<string>();
      for (const item of schema.enum) {
        if (
          typeof item !== 'string' ||
          Array.from(item).length > maxLength ||
          (minLength !== undefined && Array.from(item).length < minLength) ||
          unique.has(item)
        ) {
          throw new InvalidToolDefinitionError(
            'string enum contains an invalid or duplicate value',
          );
        }
        unique.add(item);
      }
      values = Object.freeze([...unique].sort());
    }
    return Object.freeze({
      type: 'string',
      ...(minLength === undefined ? {} : { minLength }),
      maxLength,
      ...(values === undefined ? {} : { enum: values }),
    });
  }
  if (type === 'number' || type === 'integer') {
    exactDefinitionKeys(
      schema,
      ['maximum', 'minimum', 'type'],
      [],
      'numeric JSON Schema',
    );
    if (
      typeof schema.minimum !== 'number' ||
      !Number.isFinite(schema.minimum) ||
      Math.abs(schema.minimum) > Number.MAX_SAFE_INTEGER ||
      typeof schema.maximum !== 'number' ||
      !Number.isFinite(schema.maximum) ||
      Math.abs(schema.maximum) > Number.MAX_SAFE_INTEGER ||
      schema.maximum < schema.minimum ||
      (type === 'integer' &&
        (!Number.isSafeInteger(schema.minimum) ||
          !Number.isSafeInteger(schema.maximum)))
    ) {
      throw new InvalidToolDefinitionError(
        'numeric JSON Schema bounds are invalid',
      );
    }
    return type === 'number'
      ? Object.freeze({
          type: 'number',
          minimum: schema.minimum,
          maximum: schema.maximum,
        })
      : Object.freeze({
          type: 'integer',
          minimum: schema.minimum,
          maximum: schema.maximum,
        });
  }
  if (type === 'array') {
    exactDefinitionKeys(
      schema,
      ['items', 'maxItems', 'type'],
      ['minItems', 'uniqueItems'],
      'array JSON Schema',
    );
    const maxItems = boundedInteger(
      schema.maxItems,
      0,
      MAX_TOOL_ARRAY_ITEMS,
      'array maxItems',
    );
    const minItems =
      schema.minItems === undefined
        ? undefined
        : boundedInteger(schema.minItems, 0, maxItems, 'array minItems');
    if (
      schema.uniqueItems !== undefined &&
      typeof schema.uniqueItems !== 'boolean'
    ) {
      throw new InvalidToolDefinitionError('array uniqueItems is invalid');
    }
    return Object.freeze({
      type: 'array',
      items: normalizeSchema(schema.items, depth + 1, budget),
      ...(minItems === undefined ? {} : { minItems }),
      maxItems,
      ...(schema.uniqueItems === undefined
        ? {}
        : { uniqueItems: schema.uniqueItems }),
    });
  }

  exactDefinitionKeys(
    schema,
    ['additionalProperties', 'properties', 'required', 'type'],
    [],
    'object JSON Schema',
  );
  if (schema.additionalProperties !== false) {
    throw new InvalidToolDefinitionError(
      'object additionalProperties must be false',
    );
  }
  const properties = definitionRecord(
    schema.properties,
    'JSON Schema properties',
  );
  const propertyEntries = Object.entries(properties);
  if (propertyEntries.length > MAX_TOOL_SCHEMA_PROPERTIES) {
    throw new InvalidToolDefinitionError(
      'JSON Schema property budget exceeded',
    );
  }
  const normalizedProperties: Record<string, ToolJsonSchema> = {};
  for (const [name, propertySchema] of propertyEntries.sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (!PROPERTY_NAME_PATTERN.test(name)) {
      throw new InvalidToolDefinitionError(
        'JSON Schema property name is invalid',
      );
    }
    normalizedProperties[name] = normalizeSchema(
      propertySchema,
      depth + 1,
      budget,
    );
  }
  if (
    !Array.isArray(schema.required) ||
    schema.required.length > propertyEntries.length
  ) {
    throw new InvalidToolDefinitionError(
      'JSON Schema required list is invalid',
    );
  }
  const required = new Set<string>();
  for (const item of schema.required) {
    if (
      typeof item !== 'string' ||
      !Object.hasOwn(normalizedProperties, item) ||
      required.has(item)
    ) {
      throw new InvalidToolDefinitionError(
        'JSON Schema required list is invalid or duplicated',
      );
    }
    required.add(item);
  }
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(normalizedProperties),
    required: Object.freeze([...required].sort()),
    additionalProperties: false,
  });
}

function normalizePermissions(value: unknown): readonly ProjectPermission[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_REQUIRED_PERMISSIONS) {
    throw new InvalidToolDefinitionError('required permissions are invalid');
  }
  const permissions = new Set<ProjectPermission>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new InvalidToolDefinitionError('required permission is invalid');
    }
    let permission: ProjectPermission;
    try {
      permission = normalizeProjectPermission(item);
    } catch {
      throw new InvalidToolDefinitionError('required permission is invalid');
    }
    if (permission.startsWith('tool.call:') || permissions.has(permission)) {
      throw new InvalidToolDefinitionError(
        'nested or duplicate Tool permission is invalid',
      );
    }
    permissions.add(permission);
  }
  return Object.freeze([...permissions].sort());
}

export function normalizeToolDefinition(
  value: unknown,
): Readonly<ToolDefinition> {
  const definition = definitionRecord(value, 'definition');
  exactDefinitionKeys(
    definition,
    [
      'description',
      'effect',
      'inputSchema',
      'name',
      'requiredPermissions',
      'risk',
      'timeoutSeconds',
      'version',
    ],
    ['outputSchema'],
    'definition',
  );
  const name = boundedDefinitionText(definition.name, 'name', 255);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new InvalidToolDefinitionError('name is invalid');
  }
  const version = boundedDefinitionText(definition.version, 'version', 128);
  if (semver().valid(version) !== version) {
    throw new InvalidToolDefinitionError('version is invalid');
  }
  if (
    typeof definition.effect !== 'string' ||
    !TOOL_EFFECTS.includes(definition.effect as ToolEffect) ||
    typeof definition.risk !== 'string' ||
    !TOOL_RISKS.includes(definition.risk as ToolRisk)
  ) {
    throw new InvalidToolDefinitionError('effect or risk is invalid');
  }
  const budget: SchemaBudget = { nodes: 0 };
  const inputSchema = normalizeSchema(definition.inputSchema, 1, budget);
  if (inputSchema.type !== 'object') {
    throw new InvalidToolDefinitionError(
      'input JSON Schema root must be an object',
    );
  }
  const outputSchema =
    definition.outputSchema === undefined
      ? undefined
      : normalizeSchema(definition.outputSchema, 1, budget);
  return Object.freeze({
    name,
    version,
    description: boundedDefinitionText(
      definition.description,
      'description',
      4096,
    ),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    effect: definition.effect as ToolEffect,
    risk: definition.risk as ToolRisk,
    requiredPermissions: normalizePermissions(definition.requiredPermissions),
    timeoutSeconds: boundedInteger(
      definition.timeoutSeconds,
      1,
      MAX_TOOL_TIMEOUT_SECONDS,
      'timeoutSeconds',
    ),
  });
}
