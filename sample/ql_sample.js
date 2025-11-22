/**
 * 任务名称
 * name: script name
 * 定时规则
 * cron: 1 9 * * *
 */

// Initialize QLAPI if not already loaded (for direct node execution)
if (typeof QLAPI === 'undefined') {
  const path = require('path');
  const qlDir = process.env.QL_DIR || '/ql';
  const preloadDir = path.join(qlDir, 'shell/preload');
  
  try {
    // Load the notify function
    const notifyPath = path.join(preloadDir, '__ql_notify__.js');
    const { sendNotify } = require(notifyPath);
    
    // Load the gRPC client
    const clientPath = path.join(preloadDir, 'client.js');
    const client = require(clientPath);
    
    // Create global QLAPI object
    global.QLAPI = {
      notify: sendNotify,
      ...client,
    };
  } catch (error) {
    console.error('Failed to initialize QLAPI. Please run this script using the "task" command or add it as a scheduled task.');
    console.error('Example: task ql_sample.js');
    console.error('Error details:', error.message);
    process.exit(1);
  }
}

console.log('test scripts');
QLAPI.notify('test scripts', 'test desc');
QLAPI.getEnvs({ searchValue: 'dddd' }).then((x) => {
  console.log('getEnvs', x);
});
QLAPI.systemNotify({ title: '123', content: '231' }).then((x) => {
  console.log('systemNotify', x);
});

// 查询定时任务 (Query cron tasks)
QLAPI.getCrons({ searchValue: 'test' }).then((x) => {
  console.log('getCrons', x);
});

// 通过ID查询定时任务 (Get cron by ID)
QLAPI.getCronById({ id: 1 }).then((x) => {
  console.log('getCronById', x);
}).catch((err) => {
  console.log('getCronById error', err);
});

// 启用定时任务 (Enable cron tasks)
QLAPI.enableCrons({ ids: [1, 2] }).then((x) => {
  console.log('enableCrons', x);
});

// 禁用定时任务 (Disable cron tasks)
QLAPI.disableCrons({ ids: [1, 2] }).then((x) => {
  console.log('disableCrons', x);
});

// 手动执行定时任务 (Run cron tasks manually)
QLAPI.runCrons({ ids: [1] }).then((x) => {
  console.log('runCrons', x);
});

console.log('test desc');
