const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the standalone operational CLI verifier carries its archive parser without panel dependencies', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cli-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'platformBundle.cjs');
  fs.copyFileSync(
    path.resolve(
      __dirname,
      '../../dist/internal/maintenance/platformBundle.cjs',
    ),
    filename,
  );
  const code = `
    const Module=require('node:module'),load=Module._load;
    Module._load=function(name,...args){
      if(name!==process.argv[1]&&!name.startsWith('node:')&&!Module.builtinModules.includes(name))throw new Error('External dependency: '+name);
      return load.call(this,name,...args);
    };
    const bundle=require(process.argv[1]);
    if(typeof bundle.stageBundle!=='function')throw new Error('Missing verifier');
    bundle.runtimeTarget().then(target=>console.log(bundle.targetKey(target))).catch(e=>{console.error(e);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', code, filename], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${process.platform}-`));
});
