const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Include every artifact, including imported backend modules and frontend chunks.
function collectBuildFiles(root = 'static') {
  const files = {};
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const entry = relative ? `${relative}/${name}` : name;
      if (entry === 'build-info.json') continue;
      const file = path.join(root, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error(`Build output symlink: ${entry}`);
      if (stat.isDirectory()) visit(entry);
      else if (stat.isFile()) {
        files[entry] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex');
      } else throw new Error(`Unsupported build output: ${entry}`);
    }
  }
  visit('');
  return files;
}
module.exports = { collectBuildFiles };
