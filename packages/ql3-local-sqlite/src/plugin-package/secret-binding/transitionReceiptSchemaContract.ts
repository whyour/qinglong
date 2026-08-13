export const LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_TRIGGER_NAME =
  'ql3_plugin_package_secret_binding_transition_receipt_guard' as const;

export const LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_TRIGGER_SQL =
  `
CREATE TRIGGER ${LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_TRIGGER_NAME}
BEFORE INSERT ON "QingLong3PluginPackageSecretBindingTransitionReceipts"
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
       AND install.state = 'staged'
       AND install.previous_active_lock_digest = NEW.previous_active_lock_digest
       AND install.active_lock_digest = install.previous_active_lock_digest
       AND json_extract(install.lock_json, '$.manifestDigest') = NEW.manifest_digest
       AND install.target_generation = (
         SELECT MAX(history.target_generation)
           FROM "QingLong3PluginPackageInstalls" AS history
          WHERE history.project_id = install.project_id
            AND history.package_name = install.package_name
       )
       AND EXISTS (
         SELECT 1
           FROM "QingLong3PluginPackageInstalls" AS previous
          WHERE previous.project_id = install.project_id
            AND previous.package_name = install.package_name
            AND previous.lock_digest = NEW.previous_active_lock_digest
            AND previous.state = 'active'
            AND previous.active_lock_digest = previous.lock_digest
            AND previous.target_generation < install.target_generation
       )
       AND (
         (NEW.binding_digest IS NULL AND
          json_type(NEW.receipt_json, '$.transitionPlan.nextBindingPlan') = 'null')
         OR
         (NEW.binding_digest IS NOT NULL AND
          json_type(NEW.receipt_json, '$.transitionPlan.nextBindingPlan') = 'object' AND
          EXISTS (
            SELECT 1
              FROM "QingLong3PluginPackageSecretBindings" AS binding
             WHERE binding.generation_digest = NEW.generation_digest
               AND binding.binding_digest = NEW.binding_digest
               AND binding.authority_kind = NEW.authority_kind
               AND binding.evidence_digest = NEW.evidence_digest
               AND binding.bound_at_ms = NEW.committed_at_ms
          ))
       )
  ) THEN RAISE(ABORT,
    'Plugin Package Secret binding transition receipt target is not reviewed staged generation')
  END;
END
`.trim();
