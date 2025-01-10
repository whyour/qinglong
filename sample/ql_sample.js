/**
 * 任务名称
 * name: script name
 * 定时规则
 * cron: 1 9 * * *
 */
console.log('test scripts');
QLAPI.notify('test scripts', 'test desc');
QLAPI.getEnvs({ searchValue: 'dddd' }).then(x => {
  console.log(x)
})
QLAPI.systemNotify({ title: '123', content: '231' }).then(x => {
  console.log(x)
})
console.log('test desc');
