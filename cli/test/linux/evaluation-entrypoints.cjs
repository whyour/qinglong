const fs = require('node:fs/promises');
const path = require('node:path');

// Test-only reversible switch; callers must first reject initialized panels.
exports.installEvaluationEntrypoints =
  async function installEvaluationEntrypoints() {
    if (process.env.QL_PANEL_INTEGRATION !== '1')
      throw new Error('Disposable panel required');
    const changed = [];
    const restore = async () => {
      for (const entry of changed.reverse()) {
        await fs.rm(entry.target, { force: true });
        await fs.rename(entry.backup, entry.target);
      }
    };
    try {
      for (const [name, moduleName, entry] of [
        ['task', 'runner', 'runnerMain'],
        ['ql', 'compat', 'compatibilityMain'],
      ]) {
        const target = path.join(require('node:os').homedir(), 'bin', name);
        const backup = `${target}.shell-evaluation-backup`;
        const stat = await fs.lstat(target);
        if (!stat.isSymbolicLink())
          throw new Error(`Expected original symlink: ${name}`);
        await fs.access(backup).then(
          () => {
            throw new Error('Backup already exists');
          },
          (error) => {
            if (error.code !== 'ENOENT') throw error;
          },
        );
        await fs.rename(target, backup);
        changed.push({ target, backup });
        const modulePath = path.resolve(__dirname, '../../dist', moduleName);
        await fs.writeFile(
          target,
          `#!${process.execPath}\nrequire(${JSON.stringify(
            modulePath,
          )}).${entry}().then(code => {process.exitCode = code;});\n`,
          { mode: 0o755, flag: 'wx' },
        );
      }
      if (process.env.QL_PANEL_LOADER === '1') {
        const target = '/ql/static/build/loaders/deps.js';
        const backup = `${target}.shell-evaluation-backup`;
        await fs.rename(target, backup);
        changed.push({ target, backup });
        await fs.copyFile('/candidate/deps.js', target);
      }
      return restore;
    } catch (error) {
      await restore();
      throw error;
    }
  };
