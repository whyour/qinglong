const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const load = require('../helpers/load-security-module.cjs');
const run = promisify(execFile);

test('JS and Python script reports reach the same authenticated RPC with bounded failure', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-audit-rpc-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(path.join(data, 'config'));
  const certs = await load('back/config/grpcCerts.ts', {
    './index': { configPath: path.join(data, 'config') },
    './util': { fileExist: async (p) => fs.existsSync(p) },
    '../loaders/logger': { info() {}, error() {} },
  }).initGrpcCerts();
  const definition = loader.loadSync(path.resolve('back/protos/api.proto'), {
    keepCase: true,
    defaults: true,
  });
  const Api = grpc.loadPackageDefinition(definition).com.ql.api.Api;
  const received = [];
  const server = new grpc.Server();
  server.addService(Api.service, {
    RecordNotifyLog: (call, callback) => {
      received.push(call.request);
      if (call.request.title === 'Concurrent cold startup')
        setTimeout(() => callback(null, { code: 200 }), 2000);
      else callback(null, { code: 200 });
    },
  });
  const credentials = grpc.ServerCredentials.createSsl(
    Buffer.from(certs.caCert),
    [
      {
        private_key: Buffer.from(certs.serverKey),
        cert_chain: Buffer.from(certs.serverCert),
      },
    ],
    true,
  );
  const port = await new Promise((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', credentials, (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  t.after(() => server.forceShutdown());
  const env = {
    ...process.env,
    QL_DIR: process.cwd(),
    QL_DATA_DIR: data,
    GRPC_PORT: String(port),
    ID: '9',
    HITOKOTO: 'false',
  };
  await run(
    process.execPath,
    [
      '-e',
      `require('./shell/preload/notificationAudit.js')({title:'JS task',content:'body',success:true,notifyType:'smtp',scriptName:'task.js',taskId:process.env.ID})`,
    ],
    { env, timeout: 8000 },
  );
  const python = `import importlib.util,sys,types,smtplib,os
sys.modules['requests']=types.SimpleNamespace()
spec=importlib.util.spec_from_file_location('notify',os.path.join(os.environ['QL_DIR'],'sample/notify.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
class Mail:
 def __init__(self,*a,**kw): pass
 def login(self,*a): pass
 def sendmail(self,*a): return {}
 def close(self): pass
smtplib.SMTP_SSL=Mail
n.push_config={'SMTP_SERVER':'fixture','SMTP_SSL':'true','SMTP_EMAIL':'sender@example.test','SMTP_PASSWORD':'private-password','SMTP_NAME':'fixture','HITOKOTO':False}
n.send('Python success','body')
def rejected(*a,**kw): raise RuntimeError('private-password')
smtplib.SMTP_SSL=rejected
n.send('Python failure','body')
`;
  await run('python3', ['-c', python], { env, timeout: 12000 });
  assert.deepEqual(
    received.map((x) => [x.title, x.success]),
    [
      ['JS task', true],
      ['Python success', true],
      ['Python failure', false],
    ],
  );
  assert.ok(received.every((x) => x.taskId === '9'));
  assert.ok(!JSON.stringify(received).includes('private-password'));
  // A busy host can spend longer than the former 3s timeout starting Node.
  // All channels must still arrive, using one child and one TLS connection.
  const coldStart = path.join(data, 'cold-start.cjs');
  fs.writeFileSync(
    coldStart,
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3500);',
  );
  const concurrent = `import importlib.util,sys,types,os,threading,json,subprocess
sys.modules['requests']=types.SimpleNamespace()
spec=importlib.util.spec_from_file_location('notify',os.path.join(os.environ['QL_DIR'],'sample/notify.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
barrier=threading.Barrier(3)
def accepted(title,content):
 barrier.wait(timeout=5);return True
def rejected(title,content):
 barrier.wait(timeout=5);raise RuntimeError('private-password')
def no_result(title,content):
 barrier.wait(timeout=5)
n.add_notify_function=lambda:[accepted,rejected,no_result]
original=subprocess.run
children=[]
def tracked(*args,**kwargs):
 children.append(json.loads(kwargs['input']))
 return original(*args,**kwargs)
n.subprocess.run=tracked
n.send('Concurrent cold startup','body')
assert len(children)==1,children
assert len(children[0])==3,children
`;
  await run('python3', ['-c', concurrent], {
    env: { ...env, NODE_OPTIONS: `--require=${coldStart}` },
    timeout: 14000,
  });
  assert.deepEqual(
    received
      .filter((x) => x.title === 'Concurrent cold startup')
      .map((x) => [x.notifyType, x.success])
      .sort(),
    [['accepted', true], ['no_result', false], ['rejected', false]],
  );
  // Missing certificates and an older/unavailable backend must not kill scripts.
  await run(
    process.execPath,
    [
      '-e',
      `require('./shell/preload/notificationAudit.js')({title:'offline'}).then(()=>console.log('done'))`,
    ],
    { env: { ...env, QL_DATA_DIR: path.join(data, 'missing') }, timeout: 8000 },
  );
  server.forceShutdown();
  const started = Date.now();
  await run(
    process.execPath,
    [
      '-e',
      `require('./shell/preload/notificationAudit.js')({title:'offline'})`,
    ],
    { env, timeout: 8000 },
  );
  assert.ok(Date.now() - started < 7000);
});
