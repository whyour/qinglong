"""
任务名称
name: script name
定时规则
cron: 1 9 * * *
"""
import notify

print("test script")
notify.send('test script', 'test desc')
