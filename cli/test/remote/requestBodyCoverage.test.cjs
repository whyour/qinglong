const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { openOperations } = require('../../dist/remote/api/openOperations');

test('body-consuming backend routes expose a CLI request body or upload', () => {
  const root = path.resolve(__dirname, '../../../back/api');
  let checked = 0;
  for (const filename of fs.readdirSync(root).filter(name => name.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(root, filename), 'utf8');
    const mount = text.match(/app\.use\(['"]([^'"]+)/)?.[1];
    if (!mount) continue;
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'route'
        && ['post', 'put', 'delete'].includes(node.expression.name.text)
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
        && /\breq\.body\b/.test(node.getText(source))) {
        const endpoint = [mount, node.arguments[0].text].join('/').split('/').filter(Boolean).join('/');
        const method = node.expression.name.text.toUpperCase();
        const operation = openOperations.find(item => item.method === method && item.path === endpoint);
        assert.ok(operation, `${method} ${endpoint} is missing`);
        assert.ok(operation.body || operation.upload, `${operation.name} cannot provide req.body`);
        checked++;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked > 0, 'No body-consuming routes were inspected');
});
