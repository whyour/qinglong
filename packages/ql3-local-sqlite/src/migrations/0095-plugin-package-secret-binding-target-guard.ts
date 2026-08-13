import { defineLocalSqliteMigration } from './sqlMigration';
import { LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TARGET_TRIGGER_SQL } from '../plugin-package/secret-binding/pluginPackageSecretBindingTargetSchemaContract';

export const local0095PluginPackageSecretBindingTargetGuardMigration =
  defineLocalSqliteMigration({
    id: '0095-plugin-package-secret-binding-target-guard',
    statements: [LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TARGET_TRIGGER_SQL],
  });
