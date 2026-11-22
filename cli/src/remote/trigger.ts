export function validTriggerId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,256}$/.test(value);
}
