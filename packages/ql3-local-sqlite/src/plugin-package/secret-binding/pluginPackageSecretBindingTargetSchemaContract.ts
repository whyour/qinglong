export const LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TARGET_TRIGGER_NAME =
  'ql3_plugin_package_secret_binding_target_guard' as const;

export const LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TARGET_TRIGGER_SQL = `
CREATE TRIGGER ${LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TARGET_TRIGGER_NAME}
BEFORE INSERT ON "QingLong3PluginPackageSecretBindings"
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM "QingLong3PluginPackageInstallHeads" AS head
      JOIN "QingLong3PluginPackageInstalls" AS install
        ON install.installation_id = head.installation_id
       AND install.project_id = head.project_id
       AND install.package_name = head.package_name
     WHERE head.project_id = NEW.project_id
       AND head.package_name = NEW.package_name
       AND install.installation_id = NEW.installation_id
       AND install.lock_digest = NEW.lock_digest
       AND install.target_generation = NEW.generation
       AND json_extract(install.lock_json, '$.manifestDigest') =
           NEW.manifest_digest
       AND (
         (
           install.state = 'active' AND
           install.active_lock_digest = install.lock_digest
         ) OR (
           install.state = 'staged' AND
           install.previous_active_lock_digest IS NOT NULL AND
           install.active_lock_digest = install.previous_active_lock_digest AND
           install.target_generation = (
             SELECT MAX(history.target_generation)
               FROM "QingLong3PluginPackageInstalls" AS history
              WHERE history.project_id = install.project_id
                AND history.package_name = install.package_name
           ) AND
           EXISTS (
             SELECT 1
               FROM "QingLong3PluginPackageInstalls" AS previous
              WHERE previous.project_id = install.project_id
                AND previous.package_name = install.package_name
                AND previous.lock_digest = install.previous_active_lock_digest
                AND previous.state = 'active'
                AND previous.active_lock_digest = previous.lock_digest
                AND previous.target_generation < install.target_generation
           )
         )
       )
  ) THEN RAISE(ABORT,
    'Plugin Package Secret binding target is not current active or reviewed staged generation')
  END;
END
`.trim();
