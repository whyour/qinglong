// Transport owns bounded route compilation, resolution and query validation.
import type {
  SecurityPolicyFence,
  SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type {
  ClusterControlAdmissionMetadata,
  ClusterControlAdmissionRequest,
  ClusterControlAdmissionResponse,
  ClusterControlHttpMethod,
} from './httpSurface';

export const CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS = Object.freeze({
  maxRoutes: 256,
  maxPathBytes: 1024,
  maxPathSegments: 16,
  maxPathParameters: 8,
  maxQueryParameters: 16,
  maxQueryValuesPerParameter: 16,
  maxQueryValueBytes: 1024,
});

export type ClusterControlRouteParameters = Readonly<Record<string, string>>;

export interface ClusterControlAuthorizedOperationRequest {
  readonly request: ClusterControlAdmissionRequest;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly operationId: string;
  readonly permission: string;
  readonly projectId: string | null;
  readonly policyFence: Readonly<SecurityPolicyFence> | null;
}

export interface ClusterControlRouteDefinition {
  readonly method: ClusterControlHttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly permission: string;
  readonly projectParameter: string | null;
  readonly allowedQuery?: readonly string[];
  readonly validateQuery?: (
    query: Readonly<Record<string, readonly string[]>>,
  ) => void;
  handle(
    request: ClusterControlAuthorizedOperationRequest,
    parameters: ClusterControlRouteParameters,
  ): ClusterControlAdmissionResponse | Promise<ClusterControlAdmissionResponse>;
}

export interface ClusterControlRoute {
  readonly operationId: string;
  readonly permission: string;
  readonly projectId: string | null;
  handle(
    request: ClusterControlAuthorizedOperationRequest,
  ): ClusterControlAdmissionResponse | Promise<ClusterControlAdmissionResponse>;
}

export interface ClusterControlRouteResolver {
  resolve(request: ClusterControlAdmissionMetadata): ClusterControlRoute | null;
}

export interface ClusterControlRouteRegistry
  extends ClusterControlRouteResolver {
  readonly contractVersion: 1;
  readonly size: number;
}

export class ClusterControlRouteRegistryConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Cluster-control route registry is invalid: ${message}`);
    this.name = 'ClusterControlRouteRegistryConfigurationError';
  }
}

export class ClusterControlRouteResolutionError extends Error {
  constructor(
    readonly statusCode: 400,
    readonly code: 'invalid_route_path' | 'invalid_route_query',
    message: string,
  ) {
    super(message);
    this.name = 'ClusterControlRouteResolutionError';
  }
}

type CompiledSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'parameter'; readonly name: string };

interface CompiledRoute {
  readonly method: ClusterControlHttpMethod;
  readonly operationId: string;
  readonly permission: string;
  readonly projectParameter: string | null;
  readonly segments: readonly CompiledSegment[];
  readonly allowedQuery: ReadonlySet<string>;
  readonly validateQuery?: ClusterControlRouteDefinition['validateQuery'];
  readonly handle: ClusterControlRouteDefinition['handle'];
}

const HTTP_METHODS = new Set<ClusterControlHttpMethod>([
  'DELETE',
  'GET',
  'PATCH',
  'POST',
  'PUT',
]);
const OPERATION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9_.:*:-]{0,127}$/;
const LITERAL_SEGMENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PARAMETER_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
const PARAMETER_SEGMENT_PATTERN = /^\{([a-z][A-Za-z0-9]{0,63})\}$/;
const PARAMETER_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUERY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const DEFINITION_KEYS = new Set([
  'allowedQuery',
  'handle',
  'method',
  'operationId',
  'path',
  'permission',
  'projectParameter',
  'validateQuery',
]);
const reviewedRegistries = new WeakSet<object>();

function configurationError(
  message: string,
): ClusterControlRouteRegistryConfigurationError {
  return new ClusterControlRouteRegistryConfigurationError(message);
}

function exactDefinitionShape(value: ClusterControlRouteDefinition): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError('each route must be an object');
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !DEFINITION_KEYS.has(key)) ||
    !keys.includes('method') ||
    !keys.includes('path') ||
    !keys.includes('operationId') ||
    !keys.includes('permission') ||
    !keys.includes('projectParameter') ||
    !keys.includes('handle')
  ) {
    throw configurationError('route shape is invalid');
  }
}

function compilePath(path: string): readonly CompiledSegment[] {
  if (
    typeof path !== 'string' ||
    Buffer.byteLength(path) >
      CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxPathBytes ||
    !path.startsWith('/api/v3/') ||
    path.endsWith('/') ||
    path.includes('//') ||
    path.includes('%') ||
    path.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(path)
  ) {
    throw configurationError('route path must be a canonical /api/v3 path');
  }
  const rawSegments = path.slice(1).split('/');
  if (
    rawSegments.length > CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxPathSegments
  ) {
    throw configurationError('route path has too many segments');
  }
  const parameterNames = new Set<string>();
  const compiled = rawSegments.map((segment): CompiledSegment => {
    const parameter = PARAMETER_SEGMENT_PATTERN.exec(segment)?.[1];
    if (parameter) {
      if (parameterNames.has(parameter)) {
        throw configurationError('route path repeats a parameter');
      }
      parameterNames.add(parameter);
      return Object.freeze({ kind: 'parameter', name: parameter });
    }
    if (!LITERAL_SEGMENT_PATTERN.test(segment)) {
      throw configurationError('route path contains an invalid segment');
    }
    return Object.freeze({ kind: 'literal', value: segment });
  });
  if (
    parameterNames.size >
    CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxPathParameters
  ) {
    throw configurationError('route path has too many parameters');
  }
  return Object.freeze(compiled);
}

function compileAllowedQuery(
  value: readonly string[] | undefined,
): ReadonlySet<string> {
  if (value === undefined) return new Set<string>();
  if (
    !Array.isArray(value) ||
    value.length > CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxQueryParameters
  ) {
    throw configurationError('allowedQuery is invalid');
  }
  const names = new Set<string>();
  for (const name of value) {
    if (!QUERY_NAME_PATTERN.test(name) || names.has(name)) {
      throw configurationError('allowedQuery contains an invalid name');
    }
    names.add(name);
  }
  return names;
}

function compileRoute(
  definition: ClusterControlRouteDefinition,
): CompiledRoute {
  exactDefinitionShape(definition);
  if (!HTTP_METHODS.has(definition.method)) {
    throw configurationError('route method is invalid');
  }
  if (!OPERATION_PATTERN.test(definition.operationId)) {
    throw configurationError('route operationId is invalid');
  }
  if (!PERMISSION_PATTERN.test(definition.permission)) {
    throw configurationError('route permission is invalid');
  }
  if (typeof definition.handle !== 'function') {
    throw configurationError('route handler is invalid');
  }
  if (
    definition.validateQuery !== undefined &&
    typeof definition.validateQuery !== 'function'
  ) {
    throw configurationError('route query validator is invalid');
  }
  const segments = compilePath(definition.path);
  const parameterNames = new Set(
    segments.flatMap((segment) =>
      segment.kind === 'parameter' ? [segment.name] : [],
    ),
  );
  if (
    definition.projectParameter !== null &&
    (!PARAMETER_NAME_PATTERN.test(definition.projectParameter) ||
      !parameterNames.has(definition.projectParameter))
  ) {
    throw configurationError(
      'projectParameter must name one declared path parameter',
    );
  }
  return Object.freeze({
    method: definition.method,
    operationId: definition.operationId,
    permission: definition.permission,
    projectParameter: definition.projectParameter,
    segments,
    allowedQuery: compileAllowedQuery(definition.allowedQuery),
    ...(definition.validateQuery === undefined
      ? {}
      : { validateQuery: definition.validateQuery }),
    handle: definition.handle,
  });
}

function routesOverlap(left: CompiledRoute, right: CompiledRoute): boolean {
  if (
    left.method !== right.method ||
    left.segments.length !== right.segments.length
  ) {
    return false;
  }
  return left.segments.every((segment, index) => {
    const other = right.segments[index]!;
    return (
      segment.kind === 'parameter' ||
      other.kind === 'parameter' ||
      segment.value === other.value
    );
  });
}

function validateRequestPath(path: string): readonly string[] {
  if (
    typeof path !== 'string' ||
    Buffer.byteLength(path) >
      CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxPathBytes ||
    !(path === '/api/v3' || path.startsWith('/api/v3/')) ||
    path.endsWith('/') ||
    path.includes('//') ||
    path.includes('%') ||
    path.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(path)
  ) {
    throw new ClusterControlRouteResolutionError(
      400,
      'invalid_route_path',
      'Cluster-control route path is invalid',
    );
  }
  const segments = path.slice(1).split('/');
  if (
    segments.length > CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxPathSegments ||
    segments.some((segment) => !PARAMETER_VALUE_PATTERN.test(segment))
  ) {
    throw new ClusterControlRouteResolutionError(
      400,
      'invalid_route_path',
      'Cluster-control route path is invalid',
    );
  }
  return segments;
}

function validateQuery(
  query: Readonly<Record<string, readonly string[]>>,
  allowed: ReadonlySet<string>,
): void {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ClusterControlRouteResolutionError(
      400,
      'invalid_route_query',
      'Cluster-control route query is invalid',
    );
  }
  const names = Object.keys(query);
  for (const name of names) {
    const values = query[name];
    if (
      !allowed.has(name) ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length >
        CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxQueryValuesPerParameter ||
      values.some(
        (value) =>
          typeof value !== 'string' ||
          Buffer.byteLength(value) >
            CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxQueryValueBytes ||
          CONTROL_CHARACTER_PATTERN.test(value),
      )
    ) {
      throw new ClusterControlRouteResolutionError(
        400,
        'invalid_route_query',
        'Cluster-control route query is invalid',
      );
    }
  }
}

function matchRoute(
  route: CompiledRoute,
  method: ClusterControlHttpMethod,
  segments: readonly string[],
): ClusterControlRouteParameters | null {
  if (route.method !== method || route.segments.length !== segments.length) {
    return null;
  }
  const parameters = Object.create(null) as Record<string, string>;
  for (let index = 0; index < segments.length; index += 1) {
    const definition = route.segments[index]!;
    const value = segments[index]!;
    if (definition.kind === 'literal') {
      if (definition.value !== value) return null;
    } else {
      parameters[definition.name] = value;
    }
  }
  return Object.freeze(parameters);
}

/** Returns true only for an object created by the reviewed registry factory. */
export function isClusterControlRouteRegistry(
  value: unknown,
): value is ClusterControlRouteRegistry {
  return (
    !!value &&
    typeof value === 'object' &&
    reviewedRegistries.has(value as object)
  );
}

/**
 * Compiles a bounded, immutable and non-overlapping route table. Route-owned
 * operation, permission and Project scope are resolved before authentication.
 */
export function createClusterControlRouteRegistry(
  definitions: readonly ClusterControlRouteDefinition[],
): ClusterControlRouteRegistry {
  if (
    !Array.isArray(definitions) ||
    definitions.length > CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxRoutes
  ) {
    throw configurationError('definitions must be a bounded array');
  }
  const routes = definitions.map(compileRoute);
  const operationIds = new Set<string>();
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]!;
    if (operationIds.has(route.operationId)) {
      throw configurationError('operationId must be unique');
    }
    operationIds.add(route.operationId);
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      if (routesOverlap(route, routes[otherIndex]!)) {
        throw configurationError('route definitions overlap');
      }
    }
  }

  const registry: ClusterControlRouteRegistry = {
    contractVersion: 1,
    size: routes.length,
    resolve(request) {
      const segments = validateRequestPath(request.path);
      for (const route of routes) {
        const parameters = matchRoute(route, request.method, segments);
        if (!parameters) continue;
        validateQuery(request.query, route.allowedQuery);
        if (route.validateQuery) {
          try {
            route.validateQuery(request.query);
          } catch {
            throw new ClusterControlRouteResolutionError(
              400,
              'invalid_route_query',
              'Cluster-control route query is invalid',
            );
          }
        }
        const projectId =
          route.projectParameter === null
            ? null
            : parameters[route.projectParameter]!;
        return Object.freeze({
          operationId: route.operationId,
          permission: route.permission,
          projectId,
          handle(request: ClusterControlAuthorizedOperationRequest) {
            return route.handle(request, parameters);
          },
        });
      }
      return null;
    },
  };
  reviewedRegistries.add(registry);
  return Object.freeze(registry);
}
