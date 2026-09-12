const test=require('node:test');
const assert=require('node:assert/strict');
const {setTimeout:sleep}=require('node:timers/promises');
const {SchedulerReadiness}=require('../../back/shared/schedulerReadiness');
const load=require('../helpers/load-security-module.cjs');
const fs=require('node:fs');
const ts=require('typescript');

test('readiness stays false through failed restoration and retries without idle polling',async()=>{
 let probes=0,restores=0,fail=true;
 const state=new SchedulerReadiness(async()=>{probes++;},10);
 state.configure(async()=>{restores++;if(fail)throw Error('registration failed');});
 assert.equal(await state.recover(),false);assert.equal(await state.check(),false);
 fail=false;await sleep(40);assert.equal(await state.check(),true);assert.ok(restores>=2);
 const before=probes;await sleep(40);assert.equal(probes,before);
});
test('single-flight recovery cannot mark an invalidated generation ready',async()=>{
 let release,restores=0;
 const state=new SchedulerReadiness(async()=>{},10);
 state.configure(async()=>{if(++restores===1)await new Promise(r=>release=r);});
 const a=state.recover();assert.equal(state.recover(),a);await sleep(1);
 state.invalidate();release();assert.equal(await a,false);assert.equal(await state.check(),false);
 await sleep(30);assert.equal(await state.check(),true);assert.equal(restores,2);
});
test('mutation waiting is bounded, a later recovery can succeed',async()=>{
 let release;
 const state=new SchedulerReadiness(async()=>{},10);state.configure(()=>new Promise(r=>release=r));
 await assert.rejects(state.ensureReady(15),e=>e.status===503);
 release();await sleep(1);assert.equal(await state.check(),true);
});
test('probe failure immediately invalidates a previously ready scheduler',async()=>{
 let fail=false;
 const state=new SchedulerReadiness(async()=>{if(fail)throw Error('unavailable');},10);
 state.configure(async()=>{});assert.equal(await state.recover(),true);
 fail=true;assert.equal(await state.check(),false);
 fail=false;await sleep(40);assert.equal(await state.check(),true);
});
test('health uses actual readiness and returns HTTP 503 until recovery',async(t)=>{
 let ready=false;const express=require('express');
 const {HealthService}=load('back/services/health.ts',{
  typedi:{Service:()=>x=>x},'../loaders/logger':{error(){}},'./http':{},
  '../schedule/client':{readiness:{check:async()=>ready}},
 });
 const service=new HealthService({getServer:()=>({})});
 const app=express();load('back/api/health.ts',{
  typedi:{get:()=>service},'../services/health':{HealthService},'../loaders/logger':{error(){}},
 }).default(app);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 for(const expected of [503,200,503]){
  ready=expected===200;const r=await fetch(`http://127.0.0.1:${server.address().port}/health`);const b=await r.json();
  assert.equal(r.status,expected);assert.equal(b.code,expected);assert.equal(b.data.services.grpc,ready);
 }
});
test('recovery registration errors propagate while ordinary autosave retains file synchronization',async()=>{
 const source=fs.readFileSync('back/services/cron.ts','utf8');const a=source.indexOf('  public async autosave_crontab('),z=source.indexOf('  public async bootTask',a);
 const js=ts.transpileModule('class Fixture {\n'+source.slice(a,z)+'}\nmodule.exports=Fixture;', {compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const module={exports:{}};let files=0;
 new Function('module','isDemoEnv','cronClient','withSchedulerMutation',js)(module,()=>false,{addCron:async()=>{throw Error('registration unavailable');}},fn=>fn());
 const fixture=new module.exports();fixture.crontabs=async()=>({data:[]});fixture.setCrontab=async()=>{files++;};fixture.logger={warn(){}};
 await fixture.autosave_crontab();assert.equal(files,1);
 await assert.rejects(fixture.autosave_crontab(true),/registration unavailable/);assert.equal(files,2);
});
test('scheduler probe uses the cron channel and failed writes are not replayed',async()=>{
 const calls=[];const fake={
  waitForReady(deadline,cb){calls.push(['wait',deadline]);cb();},
  makeUnaryRequest(path,serialize,deserialize,request,options,cb){calls.push(['probe',path,request,options]);cb(null,{status:1});},
  addCron(request,metadata,options,cb){calls.push(['add',request,options]);cb(Object.assign(Error('invalid'),{code:3}));},
 };
 const client=load('back/schedule/client.ts',{
  '../protos/cron':{CronClient:class{constructor(){return fake;}}},
  '../config':{grpcPort:5500},'../config/grpcCerts':{getGrpcCerts:()=>({caCert:'ca',clientKey:'key',clientCert:'cert'})},
  '@grpc/grpc-js':{...require('@grpc/grpc-js'),credentials:{createSsl:()=>({})},status:{UNAVAILABLE:14},Metadata:class{}},
 }).default;
 client.readiness.configure(async()=>{});assert.equal(await client.readiness.recover(),true);
 assert.ok(calls.filter(x=>x[0]==='probe').every(x=>x[1]==='/com.ql.health.Health/Check'&&x[2].service==='scheduler'&&x[3].deadline>Date.now()));
 await assert.rejects(client.addCron([]),/invalid/);assert.equal(calls.filter(x=>x[0]==='add').length,1);
});
test('scheduler health probe never calls back into HTTP health',async()=>{
 const {check}=load('back/schedule/health.ts',{
  '../config':{},undici:{request:()=>{throw Error('recursive HTTP health call');}},
 });
 const result=await new Promise(resolve=>check({request:{service:'scheduler'}},(error,response)=>resolve({error,response})));
 assert.equal(result.error,null);assert.deepEqual(result.response,{status:1});
});
