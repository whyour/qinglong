"""
任务名称
name: script name
定时规则
cron: 1 9 * * *
"""

print("test script")
print(QLAPI.notify("test script", "test desc"))
print("test systemNotify")
print(QLAPI.systemNotify({"title": "test script", "content": "dddd"}))
print("test getEnvs")
print(QLAPI.getEnvs({"searchValue": "1"}))
print("test desc")
