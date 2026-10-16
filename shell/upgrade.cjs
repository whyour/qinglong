// The image updater and local CLI share one implementation and build contract.
const upgrade = require('../cli/src/internal/maintenance/upgradeArtifacts.cjs');
module.exports = upgrade;
if (require.main === module)
  upgrade.main().catch((error) => {
    console.error(upgrade.upgradeMessage('更新失败: %s', process.env, error.message));
    process.exitCode = 1;
  });
