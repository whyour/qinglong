// Keep the on-disk identity for API operations; shorten only generated names.
export function readableLogName(name: string) {
  const match =
    /^(\d{4}-\d\d-\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d{3})(?:-([a-z0-9-]{8,120}))?\.log$/.exec(
      name,
    );
  if (!match) return name;
  const [, date, h, m, s, ms, id] = match;
  return `${date} ${h}:${m}:${s}.${ms}${id ? ' · ' + id.slice(-6) : ''}`;
}
