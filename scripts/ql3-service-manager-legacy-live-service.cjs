#!/usr/bin/env node

'use strict';

const http = require('node:http');

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write('legacy live service port is invalid\n');
  process.exit(64);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/api/system') {
    response.writeHead(404, { connection: 'close' });
    response.end();
    return;
  }
  const body = JSON.stringify({
    code: 200,
    data: {
      isInitialized: true,
      version: '2.21.0',
      publishTime: 1_787_200_000,
      branch: 'next-live-gate',
      changeLog: '',
      changeLogLink: '',
    },
  });
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  response.end(body);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(port, '127.0.0.1');
