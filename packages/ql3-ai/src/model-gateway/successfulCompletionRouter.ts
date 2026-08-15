import type { ModelInvocationSuccessfulCompletionSink } from './gateway';
import type {
  GenerateResult,
  ModelInvocationAuditRecord,
  ModelInvocationAuditResult,
} from './model';

export const MAX_MODEL_INVOCATION_SUCCESSFUL_COMPLETION_SINKS = 8;

export class InvalidModelInvocationSuccessfulCompletionRouterError extends TypeError {
  readonly code = 'MODEL_INVOCATION_SUCCESSFUL_COMPLETION_ROUTER_INVALID';

  constructor() {
    super('Model invocation successful completion router is invalid');
    this.name = 'InvalidModelInvocationSuccessfulCompletionRouterError';
  }
}

/** Bounded dispatch for mutually exclusive durable output domains. */
export class ModelInvocationSuccessfulCompletionRouter
  implements ModelInvocationSuccessfulCompletionSink
{
  readonly #sinks: readonly ModelInvocationSuccessfulCompletionSink[];

  constructor(sinks: readonly ModelInvocationSuccessfulCompletionSink[]) {
    if (
      !Array.isArray(sinks) ||
      sinks.length < 2 ||
      sinks.length > MAX_MODEL_INVOCATION_SUCCESSFUL_COMPLETION_SINKS ||
      new Set(sinks).size !== sinks.length ||
      sinks.some(
        (sink) =>
          !sink ||
          typeof sink !== 'object' ||
          typeof sink.record !== 'function',
      )
    ) {
      throw new InvalidModelInvocationSuccessfulCompletionRouterError();
    }
    this.#sinks = Object.freeze([...sinks]);
    Object.freeze(this);
  }

  supportsSuccessfulCompletionSink(
    sink: ModelInvocationSuccessfulCompletionSink,
  ): boolean {
    return this.#sinks.some(
      (candidate) =>
        candidate === sink ||
        candidate.supportsSuccessfulCompletionSink?.(sink) === true,
    );
  }

  async record(
    audit: Readonly<ModelInvocationAuditRecord>,
    result: Readonly<GenerateResult>,
  ): Promise<
    Readonly<
      | { handled: false }
      | { handled: true; disposition: ModelInvocationAuditResult }
    >
  > {
    for (const sink of this.#sinks) {
      const routed = await sink.record(audit, result);
      if (
        !routed ||
        typeof routed !== 'object' ||
        Array.isArray(routed) ||
        (routed.handled !== true && routed.handled !== false)
      ) {
        throw new InvalidModelInvocationSuccessfulCompletionRouterError();
      }
      if (routed.handled) return routed;
      if (Object.keys(routed).length !== 1) {
        throw new InvalidModelInvocationSuccessfulCompletionRouterError();
      }
    }
    return Object.freeze({ handled: false as const });
  }
}
