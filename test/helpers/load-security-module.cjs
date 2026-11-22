const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');

function moduleFile(file, name) {
  const target = path.resolve(path.dirname(file), name);
  const resolved = [
    target,
    `${target}.ts`,
    `${target}.js`,
    `${target}.cjs`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.js'),
  ].find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  return resolved;
}

module.exports = function loadSecurityModule(
  file,
  mocks = {},
  cache = new Map(),
  resolvedMocks,
) {
  file = path.resolve(file);
  // A dependency keeps its mock when a nested module imports it at another depth.
  resolvedMocks ??= new Map(
    Object.entries(mocks).flatMap(([name, value]) => {
      const target = name.startsWith('.') ? moduleFile(file, name) : undefined;
      return target ? [[target, value]] : [];
    }),
  );
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const localRequire = createRequire(file);
  const requireModule = (name) => {
    const resolved = name.startsWith('.') ? moduleFile(file, name) : undefined;
    if (resolvedMocks.has(resolved)) return resolvedMocks.get(resolved);
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(file), name);
      if (fs.existsSync(`${target}.ts`)) {
        return loadSecurityModule(`${target}.ts`, mocks, cache, resolvedMocks);
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
