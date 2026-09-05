// All account mutations in the HTTP service share one queue. In particular,
// a login that read old credentials must finish before a password reset revokes
// its session, and two initialization requests must not both claim the account.
let pending: Promise<unknown> = Promise.resolve();

export function serializeAuthMutation(
  _target: object,
  _key: string,
  descriptor: PropertyDescriptor,
) {
  const method = descriptor.value;
  descriptor.value = function (this: unknown, ...args: unknown[]) {
    const result = pending.then(() => method.apply(this, args));
    pending = result.catch(() => undefined);
    return result;
  };
}
