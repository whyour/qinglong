const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadFunction(file, name, bindings = {}) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../', file),
    'utf8',
  );
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = node.getText(tree).replace(/^export\s+/, '');
    } else if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === name
    ) {
      expression = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `${name} must exist in ${file}`);
  const { outputText } = ts.transpileModule(
    `const implementation = ${expression};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  );
  return new Function(
    ...Object.keys(bindings),
    `${outputText}\nreturn implementation;`,
  )(...Object.values(bindings));
}

const getCommandScript = loadFunction(
  'src/utils/index.ts',
  'getCommandScript',
  {
    window: { __ENV__QL_DIR: '/ql' },
  },
);

function navigation() {
  const paths = [];
  const external = [];
  const go = loadFunction('src/pages/crontab/index.tsx', 'goToScriptManager', {
    getCommandScript,
    history: { push: (value) => paths.push(value) },
    location: {
      set href(value) {
        external.push(value);
      },
    },
  });
  return { go, paths, external };
}

test('task command links reject executable schemes and ambiguous external targets', () => {
  const targets = [
    'javascript:alert(document.domain)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    '//attacker.example/script.js',
    '/\\attacker.example/script.js',
    'https:\\attacker.example/script.js',
    'https://trusted.example\\@attacker.example/script.js',
    'https://trusted.example\n.attacker.example/script.js',
    'https://',
    'https://[invalid',
    '/script?s=unexpected.js',
    'git@github.com:owner/repo.git',
    '',
  ];
  for (const action of ['raw', 'repo']) {
    for (const target of targets) {
      const n = navigation();
      const command = `ql ${action} ${target}`;
      n.go({ command });
      assert.deepEqual(n.external, [], command);
      assert.deepEqual(n.paths, [], command);
    }
  }
});

test('task command links preserve explicit HTTP and HTTPS repository URLs', () => {
  for (const action of ['raw', 'repo']) {
    for (const target of [
      'https://github.com/owner/repo.git',
      'http://git.example:8080/owner/repo.git',
      'HTTPS://example.com/script.js?x=1&y=2#source',
      'https://example.com/%E4%B8%AD%E6%96%87.js',
    ]) {
      const n = navigation();
      n.go({ command: `ql ${action} ${target}` });
      assert.deepEqual(n.external, [new URL(target).href]);
      assert.deepEqual(n.paths, []);
    }
  }
});

test('script navigation preserves filenames as data without injecting query parameters or fragments', () => {
  const files = [
    ['repo', 'task.js'],
    ['目录&x=1', '脚本#片段&name=evil?.js'],
    ['repo&s=wrong.js', 'name+plus%25.py'],
    ['%2f%2fattacker.example', 'a%23b.sh'],
    ['\\\\attacker.example', 'task.ts'],
    ['', 'script.js'],
  ];
  for (const [parent, file] of files) {
    const n = navigation();
    n.go({
      command: `task ${JSON.stringify(parent ? `${parent}/${file}` : file)}`,
    });
    assert.equal(n.paths.length, 1);
    const target = new URL(n.paths[0], 'https://panel.example');
    assert.equal(target.origin, 'https://panel.example');
    assert.equal(target.pathname, '/script');
    assert.equal(target.hash, '');
    assert.deepEqual(
      [...target.searchParams],
      [
        ['p', parent],
        ['s', file],
      ],
    );
    assert.deepEqual(n.external, []);
  }
});

test('command parsing still provides unencoded script paths to the task detail editor', () => {
  assert.deepEqual(getCommandScript('task /ql/data/scripts/repo/a#b&c.js'), [
    'a#b&c.js',
    '/repo',
  ]);
  assert.deepEqual(getCommandScript('python3 中文.py'), ['中文.py', '']);
  assert.equal(getCommandScript('echo hello'), undefined);
});

test('SSH repository addresses remain intact without being treated as browser URLs', () => {
  for (const address of [
    'git@github.com:owner/repo.git',
    'ssh://git@git.example/owner/repo.git',
    'ssh://git@git.example:2222/owner/repo.git',
  ]) {
    const command = `ql repo ${address}`;
    assert.equal(getCommandScript(command), address);
    const n = navigation();
    n.go({ command });
    assert.deepEqual(n.external, []);
    assert.deepEqual(n.paths, []);
  }
});

test('quoted script operands navigate to the same literal file used by the task editor', () => {
  const cases = [
    ['task "脚本.js"', '脚本.js', ''],
    [
      "task 'my dir/脚本 #?&%+.py' -- 'arg with spaces'",
      '脚本 #?&%+.py',
      'my dir',
    ],
    ['task "my dir"/script.js now', 'script.js', 'my dir'],
    [String.raw`task my\ dir/script\ name.sh`, 'script name.sh', 'my dir'],
    [String.raw`task "repo/a\"b.js"`, 'a"b.js', 'repo'],
    [String.raw`task 'repo/a'\''b.js'`, "a'b.js", 'repo'],
    [String.raw`task 'repo/a\b.js'`, String.raw`a\b.js`, 'repo'],
    [String.raw`task "repo/a\b.js"`, String.raw`a\b.js`, 'repo'],
    ['task\t-l\t"/ql/data/scripts/my dir/main.mjs"', 'main.mjs', '/my dir'],
    ['node "repo/main.cjs"', 'main.cjs', 'repo'],
    ['task "" "script.ts"', 'script.ts', ''],
  ];
  for (const [command, file, parent] of cases) {
    assert.deepEqual(getCommandScript(command), [file, parent], command);
    const n = navigation();
    n.go({ command });
    assert.equal(n.paths.length, 1, command);
    const target = new URL(n.paths[0], 'https://panel.example');
    assert.equal(target.searchParams.get('s'), file, command);
    assert.equal(target.searchParams.get('p'), parent, command);
    assert.equal(target.hash, '');
  }
});

test('incomplete quoting does not navigate to a different script', () => {
  for (const command of [
    'task "script.js',
    "task 'script.js",
    'task script.js\\',
    'task script.js\necho other',
    'task "script.js" "unfinished',
  ]) {
    assert.equal(getCommandScript(command), undefined, command);
    const n = navigation();
    n.go({ command });
    assert.deepEqual(n.paths, [], command);
    assert.deepEqual(n.external, [], command);
  }
});

test('quoted repository targets retain the web navigation safety checks', () => {
  for (const quote of ["'", '"']) {
    const safe = navigation();
    safe.go({
      command: `ql repo ${quote}https://example.com/a?x=1&y=2${quote}`,
    });
    assert.deepEqual(safe.external, ['https://example.com/a?x=1&y=2']);
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://trusted.example\\@attacker.example/a.js',
    ]) {
      const n = navigation();
      n.go({ command: `ql raw ${quote}${target}${quote}` });
      assert.deepEqual(n.paths, []);
      assert.deepEqual(n.external, []);
    }
  }
});
