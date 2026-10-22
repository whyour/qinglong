const minimum = '22.17.0';

function assertNodeRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 17)) {
    throw Object.assign(new Error(`Qinglong requires Node >=${minimum}; upgrade Node before installing. Application updates retain the existing Node.`), { code: 'UNSUPPORTED_NODE' });
  }
  if (version === process.versions.node) {
    try {
      if (typeof require('node:sqlite').DatabaseSync !== 'function') throw new Error();
    } catch {
      throw Object.assign(new Error('This Node build does not provide node:sqlite; use a Node build with SQLite support.'), { code: 'UNSUPPORTED_NODE_SQLITE' });
    }
  }
}

module.exports = { minimum, assertNodeRuntime };
