const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Inspect emitted imports so type-only references do not become false cycles.
// Include literal require() calls inside functions and executable entry points.
function runtimeModuleGraph(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|js|cjs)$/.test(file) && !file.endsWith('.d.ts'))
        files.push(file);
    }
  };
  walk(root);
  const graph = new Map(files.map((file) => [file, new Set()]));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const emitted = file.endsWith('.ts')
      ? ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2017,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            esModuleInterop: true,
          },
        }).outputText
      : source;
    const parsed = ts.createSourceFile(
      file,
      emitted,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.startsWith('.')
      ) {
        const base = path.normalize(
          path.join(path.dirname(file), node.arguments[0].text),
        );
        const target = [
          base,
          base + '.ts',
          base + '.js',
          base + '.cjs',
          path.join(base, 'index.ts'),
          path.join(base, 'index.js'),
        ].find((candidate) => graph.has(candidate));
        if (target) graph.get(file).add(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return graph;
}

function moduleCycles(graph) {
  const visited = new Set(),
    active = new Set(),
    stack = [],
    cycles = [];
  const visit = (file) => {
    if (active.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    stack.pop();
    active.delete(file);
  };
  for (const file of graph.keys()) visit(file);
  return cycles;
}

module.exports = { runtimeModuleGraph, moduleCycles };
