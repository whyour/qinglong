const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const load = require('../helpers/load-security-module.cjs');
const Http = load('back/services/http.ts', {
  '../config': {bindHost: '127.0.0.1'},
  '../loaders/logger': {debug(){},warn(){},error(){}},
  './metrics': {metricsService: {record(){}}},
  typedi: {Service:()=>x=>x},
}).HttpServerService;
test('HTTP listener preserves private binding and releases its port after shutdown',async(t)=>{
 const app=express();app.get('/',(_q,r)=>r.send('ok'));
 const first=new Http();const server=await first.initialize(app,0);
 t.after(()=>first.shutdown());
 assert.equal(server.address().address,'127.0.0.1');
 const port=server.address().port;
 const response=await fetch(`http://127.0.0.1:${port}/`,{headers:{connection:'close'}});assert.equal(await response.text(),'ok');
 await assert.rejects(new Http().initialize(app,port),e=>e.code==='EADDRINUSE');
 await first.shutdown();const replacement=new Http();t.after(()=>replacement.shutdown());
 const next=await replacement.initialize(app,port);assert.equal(next.address().port,port);
});
test('custom cluster deployments can restore shared listening',async(t)=>{
 const previous=process.env.QL_HTTP_SHARED_LISTEN;
 t.after(()=>{if(previous===undefined)delete process.env.QL_HTTP_SHARED_LISTEN;else process.env.QL_HTTP_SHARED_LISTEN=previous;});
 for(const value of [undefined,'true']){
  if(value===undefined)delete process.env.QL_HTTP_SHARED_LISTEN;else process.env.QL_HTTP_SHARED_LISTEN=value;
  let options;const service=new Http();const app=express();const listen=app.listen.bind(app);
  app.listen=(opts,cb)=>{options=opts;return listen(opts,cb);};
  await service.initialize(app,0);assert.equal(options.exclusive,value!=='true');await service.shutdown();
 }
});
