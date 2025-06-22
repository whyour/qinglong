import os
import re
import subprocess
import json
import builtins
import sys
import env
import signal
from client import Client


def try_parse_int(value):
    try:
        return int(value)
    except ValueError:
        return None


def expand_range(range_str, max_value):
    temp_range_str = (
        range_str.strip()
        .replace("-max", f"-{max_value}")
        .replace("max-", f"{max_value}-")
    )

    result = []
    for part in temp_range_str.split(" "):
        range_match = re.match(r"^(\d+)([-~_])(\d+)$", part)
        if range_match:
            start, _, end = map(try_parse_int, range_match.groups())
            step = 1 if start < end else -1
            result.extend(range(start, end + step, step))
        else:
            result.append(int(part))

    return result


def run():
    try:
        prev_pythonpath = os.getenv("PREV_PYTHONPATH", "")
        os.environ["PYTHONPATH"] = prev_pythonpath

        split_str = "__sitecustomize__"
        file_name = sys.argv[0].replace(f"{os.getenv('dir_scripts')}/", "")
        
        # 创建临时文件路径
        temp_file = f"/tmp/env_{os.getpid()}.json"
        
        # 构建命令数组
        commands = [
            f'source {os.getenv("file_task_before")} {file_name}'
        ]
        
        task_before = os.getenv("task_before")
        if task_before:
            escaped_task_before = task_before.replace('"', '\\"').replace("$", "\\$")
            commands.append(f"eval '{escaped_task_before}'")
            print("执行前置命令\n")
            
        commands.append(f"echo -e '{split_str}'")
        
        # 修改 Python 命令，使用单行并正确处理引号
        python_cmd = f"python3 -c 'import os,json; f=open(\\\"{temp_file}\\\",\\\"w\\\"); json.dump(dict(os.environ),f); f.close()'"
        commands.append(python_cmd)
        
        command = " && ".join(cmd for cmd in commands if cmd)
        command = f'bash -c "{command}"'

        res = subprocess.check_output(command, shell=True, encoding="utf-8")
        output = res.split(split_str)[0]

        try:
            with open(temp_file, 'r') as f:
                env_json = json.loads(f.read())

            for key, value in env_json.items():
                os.environ[key] = value

            os.unlink(temp_file)
        except Exception as json_error:
            print(f"\ue926 Failed to parse environment variables: {json_error}")
            try:
                os.unlink(temp_file)
            except:
                pass

        if len(output) > 0:
            print(output)
        if task_before:
            print("执行前置命令结束\n")

    except subprocess.CalledProcessError as error:
        print(f"\ue926 run task before error: {error}")
        if task_before:
            print("执行前置命令结束\n")
    except OSError as error:
        error_message = str(error)
        if "Argument list too long" not in error_message:
            print(f"\ue926 run task before error: {error}")
        # else:
            # environment variable is too large
        if task_before:
            print("执行前置命令结束\n")
    except Exception as error:
        print(f"\ue926 run task before error: {error}")
        if task_before:
            print("执行前置命令结束\n")

    import task_before

    env_param = os.getenv("envParam")
    num_param = os.getenv("numParam")

    if env_param and num_param:
        array = (os.getenv(env_param) or "").split("&")
        run_arr = expand_range(num_param, len(array))
        array_run = [array[i - 1] for i in run_arr if i - 1 < len(array) and i > 0]
        env_str = "&".join(array_run)
        os.environ[env_param] = env_str


def handle_sigterm(signum, frame):
    sys.exit(15)


try:
    signal.signal(signal.SIGTERM, handle_sigterm)

    run()

    from __ql_notify__ import send

    class BaseApi(Client):
        def notify(self, *args, **kwargs):
            return send(*args, **kwargs)

    QLAPI = BaseApi()
    builtins.QLAPI = QLAPI
except Exception as error:
    print(f"run builtin code error: {error}\n")
