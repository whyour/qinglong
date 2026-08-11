/** Bounded Prompt Output maintenance PostgreSQL connection boundary. */
import {
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
} from '@qinglong/cluster-postgres/ai-maintenance';

export function loadPromptOutputPostgresMaintenanceConnection(
  environment: NodeJS.ProcessEnv,
): PostgresConnectionOptions {
  const base = loadPostgresConnectionEnvironment(environment, {
    connectionString: 'QL3_POSTGRES_AI_MAINTENANCE_URL',
    host: 'QL3_POSTGRES_AI_MAINTENANCE_HOST',
    port: 'QL3_POSTGRES_AI_MAINTENANCE_PORT',
    database: 'QL3_POSTGRES_AI_MAINTENANCE_DATABASE',
    user: 'QL3_POSTGRES_AI_MAINTENANCE_USER',
    password: 'QL3_POSTGRES_AI_MAINTENANCE_PASSWORD',
  });
  const mode = environment.QL3_POSTGRES_TLS_MODE ?? 'verify-full';
  if (mode === 'disable') {
    if (environment.QL3_POSTGRES_ALLOW_INSECURE !== 'true') {
      throw new TypeError('Insecure PostgreSQL requires an explicit gate');
    }
    return Object.freeze({ ...base, tls: { mode: 'disable' as const } });
  }
  if (mode !== 'verify-full') {
    throw new TypeError('PostgreSQL TLS mode is invalid');
  }
  const caFile = environment.QL3_POSTGRES_TLS_CA_FILE;
  const servername = environment.QL3_POSTGRES_TLS_SERVERNAME;
  if (!caFile || !servername) {
    throw new TypeError('PostgreSQL TLS CA and servername are required');
  }
  return Object.freeze({
    ...base,
    tls: {
      mode: 'verify-full' as const,
      ca: loadPostgresCertificateAuthorityFile(caFile),
      servername,
    },
  });
}
