const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');

module.exports = function loadSecurityModule(
  file,
  mocks = {},
  cache = new Map(),
) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const localRequire = createRequire(file);
  const requireModule = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(file), name);
      if (fs.existsSync(`${target}.ts`)) {
        return loadSecurityModule(`${target}.ts`, mocks, cache);
      }
    }
    return localRequire(name);
  };
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      experimentalDecorators: true,
      esModuleInterop: true,
    },
  });
  // Use the host realm: express-unless checks RegExp with instanceof.
  new Function('require', 'module', 'exports', '__dirname', outputText)(
    requireModule,
    module,
    module.exports,
    path.dirname(file),
  );
  return module.exports;
};
