const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const prettier = require('prettier');

process.chdir(path.resolve(__dirname, '..'));
const check = process.argv.includes('--check');
// Include new source files, but never build output or ignored local tooling.
const files = new Set(
  execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  )
    .split('\0')
    .filter(Boolean),
);
let checked = 0;
let changed = 0;
for (const file of [...files].sort()) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
  const info = prettier.getFileInfo.sync(file, {
    ignorePath: '.prettierignore',
  });
  if (info.ignored) continue;
  const options = {
    ...prettier.resolveConfig.sync(file, { editorconfig: true }),
    filepath: file,
  };
  if (!info.inferredParser && !options.parser) continue;
  checked++;
  const original = fs.readFileSync(file, 'utf8');
  const formatted = prettier.format(original, options);
  if (original === formatted) continue;
  changed++;
  console.log(file);
  if (!check) fs.writeFileSync(file, formatted);
}
console.log(
  `${checked} files checked; ${changed} ${
    check ? 'need formatting' : 'formatted'
  }.`,
);
if (check && changed) process.exitCode = 1;
