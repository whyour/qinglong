import { AsyncLocalStorage } from 'async_hooks';
import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { setTimeout, clearTimeout } from 'timers';
import { DatabaseError } from './databaseErrors';

type Scope = { active: boolean; child: boolean; token: number };
type Reply = {
  id: number;
  value?: any;
  error?: { code: string; message: string };
};
type Limits = { timeoutMs?: number; queueLimit?: number };

// One worker per backend process; SQLite itself coordinates independent processes.
// A transaction owns this client's queue until its callback and commit finish.
export class DatabaseClient {
  private worker?: ChildProcess;
  private stopped: Promise<void> = Promise.resolve();
  private failed?: Error;
  private closed = false;
  private nextId = 0;
  private queued = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private scope = new AsyncLocalStorage<Scope>();

  private readonly timeoutMs: number;
  private readonly queueLimit: number;

  constructor(
    public readonly storage: string,
    private cacheStorage?: string,
    limits: Limits = {},
  ) {
    this.timeoutMs =
      limits.timeoutMs ?? (process.arch === 'arm' ? 300000 : 60000);
    this.queueLimit = limits.queueLimit ?? 256;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      !Number.isSafeInteger(this.queueLimit) ||
      this.queueLimit < 1
    )
      throw new Error('Invalid database worker limits');
  }

  private abort(error: Error) {
    this.failed ||= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failed);
    }
    this.pending.clear();
    this.unref();
    this.worker?.kill('SIGKILL');
  }

  private unref() {
    this.worker?.unref();
    this.worker?.channel?.unref();
  }

  private start() {
    if (this.worker) return this.worker;
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 17))
      throw new DatabaseError(
        'Qinglong requires Node >=22.17; keep the previous installation until Node is upgraded',
        'UNSUPPORTED_NODE',
      );
    // ts-node's CLI places its executable in execArgv, rather than using -r.
    // Source workers register their own compiler; compiled workers need none.
    const preloads = __filename.endsWith('.ts')
      ? ['--require', require.resolve('ts-node/register/transpile-only')]
      : [];
    const armv6 =
      process.arch === 'arm' &&
      Number(
        (process.config.variables as { arm_version?: string | number })
          .arm_version,
      ) === 6;
    const worker = fork(require.resolve('./databaseProcess'), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [
        ...preloads,
        ...(armv6 ? ['--jitless'] : []),
        '--max-old-space-size=128',
      ],
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        ...(__filename.endsWith('.ts')
          ? { TS_NODE_PROJECT: join(__dirname, 'tsconfig.worker.json') }
          : {}),
      },
    });
    this.stopped = new Promise((resolve) =>
      worker.once('close', () => resolve()),
    );
    const onOwnerExit = () => worker.kill('SIGKILL');
    process.once('exit', onOwnerExit);
    worker.once('close', () => process.removeListener('exit', onOwnerExit));
    this.worker = worker;
    worker.on('message', (reply: Reply & { type?: string }) => {
      if (reply.type === 'fatal' && reply.error) {
        this.abort(new DatabaseError(reply.error.message, reply.error.code));
        return;
      }
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (!this.pending.size) this.unref();
      if (reply.error)
        request.reject(
          new DatabaseError(reply.error.message, reply.error.code),
        );
      else request.resolve(reply.value);
    });
    const fail = () =>
      this.abort(
        new DatabaseError(
          'Database worker stopped; restart the service before retrying a write',
          'DATABASE_WORKER_EXIT',
        ),
      );
    worker.on('error', fail);
    worker.on('exit', () => {
      if (!this.closed) fail();
    });
    worker.send({
      storage: this.storage,
      cacheStorage: this.cacheStorage,
      ownerPid: process.pid,
    });
    this.unref();
    return worker;
  }

  private send(
    operation: string,
    args: any[] = [],
    token?: number,
  ): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed)
      return Promise.reject(
        new DatabaseError('Database is closed', 'DATABASE_CLOSED'),
      );
    return new Promise((resolve, reject) => {
      try {
        const worker = this.start();
        const id = ++this.nextId;
        const timer = setTimeout(
          () =>
            this.abort(
              new DatabaseError(
                'Database worker timed out; writes are never automatically replayed',
                'DATABASE_WORKER_TIMEOUT',
              ),
            ),
          this.timeoutMs,
        );
        timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        worker.ref();
        worker.channel?.ref();
        try {
          worker.send({ id, operation, args, token }, (error) => {
            if (error)
              this.abort(
                new DatabaseError(
                  'Database IPC disconnected',
                  'DATABASE_WORKER_EXIT',
                ),
              );
          });
        } catch (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          if (!this.pending.size) this.unref();
          reject(error);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  private exclusive<T>(
    operation: () => Promise<T>,
    shutdown = false,
  ): Promise<T> {
    if (!shutdown && this.queued >= this.queueLimit)
      return Promise.reject(
        new DatabaseError('Database request queue is full', 'DATABASE_BUSY'),
      );
    this.queued++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(() => {
      this.queued--;
      release();
    });
  }

  request<T = any>(operation: string, ...args: any[]): Promise<T> {
    const scope = this.scope.getStore();
    if (scope) {
      if (!scope.active || scope.child)
        return Promise.reject(
          new DatabaseError(
            'Transaction scope is no longer available',
            'TRANSACTION_SCOPE',
          ),
        );
      if (this.pending.size >= this.queueLimit)
        return Promise.reject(
          new DatabaseError('Database request queue is full', 'DATABASE_BUSY'),
        );
      return this.send(operation, args, scope.token);
    }
    return this.exclusive(() => this.send(operation, args));
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const parent = this.scope.getStore();
    if (parent && (!parent.active || parent.child))
      throw new DatabaseError(
        'Concurrent or expired nested transaction',
        'TRANSACTION_SCOPE',
      );
    const run = async () => {
      const token = ++this.nextId;
      if (parent) parent.child = true;
      const scope: Scope = { active: true, child: false, token };
      let began = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        await this.send('begin', [], token);
        began = true;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DatabaseError(
                  'Database transaction timed out',
                  'DATABASE_TRANSACTION_TIMEOUT',
                ),
              ),
            this.timeoutMs,
          );
        });
        const value = await Promise.race([
          this.scope.run(scope, operation),
          deadline,
        ]);
        scope.active = false;
        await this.send('commit', [], token);
        return value;
      } catch (error) {
        scope.active = false;
        if (began) {
          try {
            await this.send('rollback', [], token);
          } catch {
            this.abort(
              new DatabaseError(
                'Transaction rollback failed; restart the service',
                'DATABASE_ROLLBACK_FAILED',
              ),
            );
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (parent) parent.child = false;
      }
    };
    return parent ? run() : this.exclusive(run);
  }

  query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.request('query', sql, params);
  }

  get healthy() {
    return !this.failed && !this.closed;
  }

  async close() {
    if (this.scope.getStore())
      throw new DatabaseError(
        'Cannot close within a transaction',
        'TRANSACTION_SCOPE',
      );
    await this.exclusive(async () => {
      if (this.closed) return;
      try {
        if (this.worker && !this.failed) await this.send('close');
      } finally {
        this.closed = true;
        this.worker?.ref();
        this.worker?.kill('SIGKILL');
        await this.stopped;
      }
    }, true);
  }
}
