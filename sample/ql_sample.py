"""
任务名称
name: script name
定时规则
cron: 1 9 * * *
"""
print("test script")
QLAPI.notify('test script', 'test desc')
print("test desc")
