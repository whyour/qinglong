import { Sequelize } from 'sequelize';

// Limit compatibility handling to our Sequelize instance rather than changing
// the globally shared dialect parsers. SQLite can store INTEGERs in DATETIME.
export function configureSqliteParsers(database: Sequelize): void {
  const dialect = (database as any).dialect;
  const Query = dialect.Query;
  dialect.Query = class CompatibleSqliteQuery extends Query {
    applyParsers(type: unknown, value: unknown) {
      const normalizedType = String(type ?? '')
        .replace(/\(.*/, '')
        .replace(/UNSIGNED|ZEROFILL/g, '')
        .trim()
        .toUpperCase();
      if (normalizedType === 'DATETIME' && value !== null) {
        if (value instanceof Date) return new Date(value.getTime());
        if (typeof value === 'number') return new Date(value);
        if (typeof value === 'string') {
          if (/^-?\d{11,}$/.test(value)) return new Date(Number(value));
          const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
          return new Date(
            hasTimezone ? value : value + this.sequelize.options.timezone,
          );
        }
      }
      return super.applyParsers(normalizedType, value);
    }
  };
}
