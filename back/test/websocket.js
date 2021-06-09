const WebSocket = require('ws');

const ws = new WebSocket(
  'ws://localhost:5600/api/terminal/123?token=eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIiwicGFzc3dvcmQiOiJMV0QtRkR5OGVZS19pMG55cGVSYjYiLCJpYXQiOjE2MjI3MjYwMDksImV4cCI6MTYyMzMzMDgwOX0.skpXpLQ9Rzbwsj17NFSC3BVoLEqf9ttvLh3JR6irKcY40mLbw--pCDL5QlmEjOem',
);

ws.on('open', function open() {
  ws.send('something');
});

ws.on('message', function incoming(data) {
  console.log(data);
});
