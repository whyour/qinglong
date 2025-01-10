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
        command = f'bash -c "source {os.getenv("file_task_before")} {file_name}'
        task_before = os.getenv("task_before")

        if task_before:
            escape_task_before = task_before.replace('"', '\\"').replace("$", "\\$")
            command += f" && eval '{escape_task_before}'"
            print("执行前置命令\n")

        prev_pythonpath = os.getenv("PREV_PYTHONPATH", "")
        python_command = (
            "python3 -c 'import os, json; print(json.dumps(dict(os.environ)))'"
        )
        command += f" && echo -e '{split_str}' && {python_command}\""

        res = subprocess.check_output(command, shell=True, encoding="utf-8")
        output, env_str = res.split(split_str)

        env_json = json.loads(env_str.strip())

        for key, value in env_json.items():
            os.environ[key] = value

        if len(output) > 0:
            print(output)
        if task_before:
            print("执行前置命令结束")

    except subprocess.CalledProcessError as error:
        print(f"run task before error: {error}")
    except OSError as error:
        error_message = str(error)
        if "Argument list too long" not in error_message:
            print(f"\ue926 run task before error: {error}")
        else:
            print(
                "\ue926 The environment variable is too large. It is recommended to use task_before.py instead of task_before.sh\n"
            )
        if task_before:
            print("执行前置命令结束")
    except Exception as error:
        print(f"run task before error: {error}")

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

    from notify import send

    class BaseApi(Client):
        def notify(self, *args, **kwargs):
            return send(*args, **kwargs)

    QLAPI = BaseApi()
    builtins.QLAPI = QLAPI
except Exception as error:
    print(f"run builtin code error: {error}\n")
