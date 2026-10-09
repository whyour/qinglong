#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const sqlite3 = require('sqlite3');
const { Sequelize, DataTypes } = require('sequelize');
const jwt = require('jsonwebtoken');
const protobuf = require('node:module').createRequire(
  require.resolve('@grpc/proto-loader'),
)('protobufjs');
const grpc = require('@grpc/grpc-js');
const sockjs = require('sockjs');
const { WebSocket, ProxyAgent } = require('undici');
const nodemailer = require('nodemailer');

async function verifyDatabase() {
  const db = new sqlite3.Database(':memory:');
  try {
    const row = await new Promise((resolve, reject) =>
      db.get('SELECT sqlite_version() AS version', (error, row) =>
        error ? reject(error) : resolve(row),
      ),
    );
    assert.match(row.version, /^\d+\.\d+\.\d+$/);
  } finally {
    await new Promise((resolve, reject) =>
      db.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const orm = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  try {
    const Task = orm.define('ReadinessTask', {
      name: DataTypes.STRING,
      payload: DataTypes.JSON,
    });
    await orm.sync();
    await orm.transaction(async (transaction) => {
      await Task.create(
        { name: 'readiness', payload: { status: 'ready' } },
        { transaction },
      );
    });
    const task = await Task.findOne({ where: { name: 'readiness' } });
    assert.deepEqual(task.get('payload'), { status: 'ready' });
    await task.update({ name: 'verified' });
    assert.equal(await Task.count({ where: { name: 'verified' } }), 1);
  } finally {
    await orm.close();
  }
}

async function verifyGrpc() {
  const Message = protobuf.Root.fromJSON({
    nested: {
      Message: { fields: { value: { type: 'string', id: 1 } } },
    },
  }).lookupType('Message');
  const serialize = (value) => Buffer.from(Message.encode(value).finish());
  const deserialize = (value) => Message.toObject(Message.decode(value));
  const definition = {
    echo: {
      path: '/readiness.Echo/Echo',
      requestStream: false,
      responseStream: false,
      requestSerialize: serialize,
      requestDeserialize: deserialize,
      responseSerialize: serialize,
      responseDeserialize: deserialize,
    },
  };
  const server = new grpc.Server();
  server.addService(definition, {
    echo: (call, callback) => callback(null, call.request),
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const Client = grpc.makeGenericClientConstructor(definition, 'Echo');
  const client = new Client(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  try {
    const response = await new Promise((resolve, reject) =>
      client.echo(
        { value: 'ready' },
        { deadline: Date.now() + 5000 },
        (error, response) => (error ? reject(error) : resolve(response)),
      ),
    );
    assert.equal(response.value, 'ready');
  } finally {
    client.close();
    server.forceShutdown();
  }
}

async function verifyWebsocket() {
  const server = createServer();
  const transport = sockjs.createServer({
    prefix: '/readiness',
    log: () => {},
  });
  transport.on('connection', (connection) =>
    connection.on('data', (message) => connection.write(message)),
  );
  transport.installHandlers(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/readiness/000/fixture/websocket`,
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WebSocket echo timed out')),
        5000,
      );
      client.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket connection failed'));
      });
      client.addEventListener('message', ({ data }) => {
        if (data === 'o') client.send(JSON.stringify(['dependency-readiness']));
        else {
          try {
            assert.equal(data, 'a["dependency-readiness"]');
            clearTimeout(timer);
            resolve();
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        }
      });
    });
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const proxy = new ProxyAgent('http://127.0.0.1:1');
  await proxy.close();
}

async function verifyMailAndJwt() {
  const token = jwt.sign({ readiness: true }, 'local-fixture-secret', {
    expiresIn: 60,
  });
  assert.equal(jwt.verify(token, 'local-fixture-secret').readiness, true);
  assert.throws(() => jwt.verify(token, 'different-local-fixture-secret'));
  const mail = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  try {
    const message = await mail.sendMail({
      from: 'Qinglong <readiness@localhost>',
      to: 'fixture@localhost',
      subject: 'Dependency readiness',
      text: 'Local fixture only',
    });
    assert.match(message.message.toString(), /Local fixture only/);
    assert.deepEqual(message.envelope.to, ['fixture@localhost']);
  } finally {
    mail.close();
  }
}

(async () => {
  for (const verify of [
    verifyDatabase,
    verifyGrpc,
    verifyWebsocket,
    verifyMailAndJwt,
  ]) {
    await verify();
    console.log(`${verify.name}: passed`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
