import { defineLocalSqliteMigration } from './sqlMigration';
import { LOCAL_PLUGIN_PACKAGE_SECRET_MATERIALIZATION_TRIGGER_SQL } from '../plugin-package/pluginPackageSecretMaterializationSchemaContract';

export const local0093PluginPackageSecretMaterializationGuardMigration =
  defineLocalSqliteMigration({
    id: '0093-plugin-package-secret-materialization-guard',
    statements: [LOCAL_PLUGIN_PACKAGE_SECRET_MATERIALIZATION_TRIGGER_SQL],
  });
