import { errStack } from '../shared/errors';

// Also terminate if the primary disappears without forwarding a signal.
const onParentDisconnect = () => process.exit(1);
process.once('disconnect', onParentDisconnect);

async function initializeDatabase() {
  const { sequelize } = await import('../data');
  try {
    const { default: loadDatabase } = await import('../loaders/db');
    await loadDatabase();
  } finally {
    await sequelize.close();
  }
}

initializeDatabase()
  .catch((error) => {
    console.error(`[boot] Database initialization failed:\n${errStack(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('disconnect', onParentDisconnect);
    // Let pending log writes drain and exit naturally after closing SQLite.
    if (process.connected) process.disconnect();
  });
