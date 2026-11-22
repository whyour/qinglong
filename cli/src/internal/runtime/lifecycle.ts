import { randomUUID } from 'node:crypto';
import type { LocalContext } from './context';
import { LocalApi, ReceiptValidationError } from './api';

// Negotiate with the worker that validates the real receipt. Keep the agreed
// wire format for this execution, even if the panel changes before it exits.
export class LifecycleReceipt {
  private readonly api: LocalApi;
  private identity?: { trigger_id: string } | { execution_id: string };
  private extended: boolean;
  private startAttempted = false;
  private acceptedStart = false;
  private finishedAt?: number;
  readonly triggerId?: string;

  constructor(context: LocalContext, started: number) {
    this.api = new LocalApi(context);
    this.extended = context.env.QL_CLI_LIFECYCLE !== 'legacy';
    const parent = context.env.QL_TRIGGER_ID;
    if (!this.extended) return;
    if (parent && /^[a-z0-9-]{1,120}$/.test(parent)) {
      this.triggerId = parent;
      this.identity = { trigger_id: parent };
    } else {
      const prefix =
        context.env.QL_EXECUTION_ORIGIN === 'scheduled_system'
          ? `legacy-system:${started}:`
          : 'client-';
      this.identity = { execution_id: prefix + randomUUID() };
    }
  }

  get executionId() {
    return this.identity && 'execution_id' in this.identity
      ? this.identity.execution_id
      : undefined;
  }

  async status(body: Record<string, unknown>, exitCode?: number) {
    const starting = exitCode === undefined;
    const firstStart = starting && !this.startAttempted;
    if (starting) this.startAttempted = true;
    if (!starting && this.identity) this.finishedAt ??= Date.now();
    try {
      await this.api.call(
        'crons/status',
        'PUT',
        {
          ...body,
          ...this.identity,
          ...(!starting && this.extended && { exit_code: exitCode }),
        },
        starting ? undefined : this.finishedAt,
      );
    } catch (error) {
      if (!(error instanceof ReceiptValidationError)) throw error;
      if (firstStart && this.identity && error.field in this.identity) {
        // The old schema rejected this start before its handler could write.
        this.identity = undefined;
      } else if (
        !starting &&
        !this.identity &&
        this.extended &&
        error.field === 'exit_code'
      ) {
        this.extended = false;
      } else {
        throw error;
      }
      await this.api.call('crons/status', 'PUT', body);
    }
    if (starting) this.acceptedStart = true;
  }

  async statistics(refId: number, code: number, elapsed: number) {
    if (this.extended && (this.identity || this.acceptedStart))
      await this.api.call(
        'dashboard/record',
        'POST',
        { ref_id: refId, code, elapsed, ...this.identity },
        this.finishedAt,
      );
  }
}
