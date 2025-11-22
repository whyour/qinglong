"""
任务名称
name: script name
定时规则
cron: 1 9 * * *
"""

# Initialize QLAPI if not already loaded (for direct python execution)
try:
    QLAPI
except NameError:
    import os
    import sys
    from pathlib import Path
    
    ql_dir = os.getenv('QL_DIR', '/ql')
    preload_dir = Path(ql_dir) / 'shell' / 'preload'
    
    # Add preload directory to Python path
    sys.path.insert(0, str(preload_dir))
    
    try:
        from __ql_notify__ import send
        from client import Client
        
        class BaseApi(Client):
            def notify(self, *args, **kwargs):
                return send(*args, **kwargs)
        
        QLAPI = BaseApi()
    except Exception as error:
        print('\n❌ Failed to initialize QLAPI. This usually happens because:')
        print('   1. The Qinglong backend is not running')
        print('   2. Required files are not yet generated\n')
        print('Solution: Use the "task" command instead of running directly:')
        print('   Example: task ql_sample.py')
        print('   Or add this script as a scheduled task in the panel\n')
        print(f'Error details: {error}')
        sys.exit(1)

print("test script")
print(QLAPI.notify("test script", "test desc"))
print("test systemNotify")
print(QLAPI.systemNotify({"title": "test script", "content": "dddd"}))
print("test getEnvs")
print(QLAPI.getEnvs({"searchValue": "1"}))
print("test desc")
