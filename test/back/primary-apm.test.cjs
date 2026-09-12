const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('ecosystem.config.js', 'utf8');
const appSource = fs.readFileSync('back/app.ts', 'utf8');
const ts = require('typescript');
const compiled = ts.transpileModule(appSource.slice(0, appSource.indexOf('\nconst app = new Application();')) + '\nmodule.exports = Application;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function config(env) {const module={exports:{}};vm.runInNewContext(source,{module,process:{env}});return module.exports.apps[0];}
test('container APM policy keeps worker isolation and can restore all inherited probes', () => {
  for (const primary of [undefined, 'true']) for (const workers of [undefined, 'true']) {
    const env={QL_CONTAINER:'true',QL_PRIMARY_APM:primary,QL_WORKER_APM:workers};
    const conf=config(env);env.pm_id='0';env.pmx=String(conf.pmx);
    const calls=[],module={exports:{}};
    vm.runInNewContext(compiled,{module,exports:module.exports,process:{env},require(name){if(name==='cluster')return {fork(options){calls.push({...env,...options});return {id:1,process:{pid:123}}}};if(name==='express')return ()=>({use(){}});return {};}});
    new module.exports().forkWorker('http');
    assert.equal(conf.pmx,primary==='true');
    assert.equal(calls[0].pmx,primary==='true'&&workers==='true'?'true':'false');
    assert.equal(conf.max_restarts,5);assert.equal(conf.script,'static/build/app.js');
  }
});
test('standalone PM2 monitoring stays enabled', () => {
  for(const QL_PRIMARY_APM of [undefined,'true','false']) assert.equal(config({QL_PRIMARY_APM}).pmx,true);
});
