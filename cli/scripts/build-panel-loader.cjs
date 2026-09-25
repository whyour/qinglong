// Build only the 2.x command-selection loader, without invoking 3.x backend builds.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = path.resolve(__dirname, '../../back/loaders/deps.ts');
const output = path.resolve(__dirname, '../docker/build/deps.js');
const result = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  reportDiagnostics: true,
});
const errors = (result.diagnostics || []).filter(
  (item) => item.category === ts.DiagnosticCategory.Error,
);
if (errors.length)
  throw new Error(
    ts.formatDiagnostics(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }),
  );
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, result.outputText);
