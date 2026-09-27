const test = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('@grpc/grpc-js');
const load = require('../helpers/load-security-module.cjs');
const { SchedulerReadiness } = require('../../back/shared/schedulerReadiness');

for (const [name, rows, delay, succeeds] of [
  ['large distinct snapshot', Array.from({length:10000}, (_, i) => ({id:String(i), schedule:`${i%60} ${Math.floor(i/60)%60} ${Math.floor(i/3600)} * * *`})), 10000, true],
  ['extra schedules', [{id:'extra', schedule:'* * * * *', extra_schedules:Array.from({length:2000},()=>({schedule:'0 * * * *'}))}], 10000, true],
  ['unresponsive small write', [{id:'small', schedule:'* * * * *'}], 30000, false],
  ['unresponsive large write remains bounded', Array.from({length:30000},()=>({schedule:'* * * * *'})), 180000, false],
]) {
  test(`recovery deadline: ${name}`, async (t) => {
    t.mock.timers.enable({apis:['Date','setTimeout'], now:0});
    let calls=0, deadline;
    const fake={waitForReady:(_,cb)=>cb(), addCron:(_req,_meta,options,cb)=>{
      calls++; deadline=options.deadline;
      const budget=deadline-Date.now();
      setTimeout(()=>cb(delay<=budget ? null : Object.assign(Error('deadline'),{code:grpc.status.DEADLINE_EXCEEDED}), {}), Math.min(delay,budget));
    }};
    const client=load('back/schedule/client.ts', {
      '../protos/cron':{CronClient:class{constructor(){return fake}}},
      '../config':{grpcPort:5500},
      '../config/grpcCerts':{getGrpcCerts:()=>({caCert:'ca',clientKey:'key',clientCert:'cert'})},
      '@grpc/grpc-js':{...grpc,credentials:{createSsl:()=>({})}},
    }).default;
    const readiness=new SchedulerReadiness(async()=>{}, 60000);
    t.after(()=>clearTimeout(readiness.retry));
    client.readiness=readiness;
    readiness.configure(()=>client.addCron(rows,true));
    const recovering=readiness.recover();
    await new Promise(setImmediate);
    assert.equal(calls,1);
    assert.ok(deadline<=120000);
    t.mock.timers.tick(Math.min(delay,deadline));
    assert.equal(await recovering,succeeds);
    assert.equal(calls,1,'uncertain writes are not replayed inline');
    assert.equal(await readiness.check(),succeeds);
  });
}
