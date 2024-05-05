/**
 * 任务名称
 * name: script name
 * 定时规则
 * cron: 1 9 * * *
 */
const { sendNotify } = require('./sendNotify.js'); // commonjs
// import { sendNotify } from './sendNotify'; // es6

console.log('test scripts');
sendNotify('test scripts', 'test desc');
