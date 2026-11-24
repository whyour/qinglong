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
    task_before = os.getenv("task_before", "")
    try:
        prev_pythonpath = os.getenv("PREV_PYTHONPATH", "")
        os.environ["PYTHONPATH"] = prev_pythonpath

        split_str = "__sitecustomize__"
        file_name = sys.argv[0].replace(f"{os.getenv('dir_scripts')}/", "")
        
        # 创建临时文件路径
        temp_file = f"/tmp/env_{os.getpid()}.data"
        
        if task_before:
            print("Executing before command\n" if os.environ.get("QL_LANG") == "en" else "执行前置命令\n")
        # Pass paths as arguments, without interpreting filename shell syntax.
        command = """file="$1"; output="$2"; inline="$3"; shift 3
source "$file" "$@" &&
{ if [ -n "$inline" ]; then eval "$inline"; fi; } &&
printf '%s\\n' '__sitecustomize__' &&
{ command env -0 > "$output" 2>/dev/null ||
python3 -c 'import os,json,sys; f=open(sys.argv[1],"w"); json.dump(dict(os.environ),f); f.close()' "$output"; }
"""
        res = subprocess.check_output(
            ["/bin/bash", "-c", command, "ql-before", os.environ["file_task_before"],
             temp_file, task_before, file_name],
            encoding="utf-8",
        )
        output = res.split(split_str)[0]

        try:
            with open(temp_file, 'rb') as f:
                data = f.read()
            # fsdecode retains undecodable Unix environment bytes, as os.environ does.
            env_json = (dict((os.fsdecode(key), os.fsdecode(value))
                            for key, _, value in (entry.partition(b'=') for entry in data.split(b'\0') if entry))
                        if b'\0' in data else json.loads(data))

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
            print("Before command finished\n" if os.environ.get("QL_LANG") == "en" else "执行前置命令结束\n")

    except subprocess.CalledProcessError as error:
        print(f"\ue926 run task before error: {error}")
        if task_before:
            print("Before command finished\n" if os.environ.get("QL_LANG") == "en" else "执行前置命令结束\n")
    except OSError as error:
        error_message = str(error)
        if "Argument list too long" not in error_message:
            print(f"\ue926 run task before error: {error}")
        # else:
            # environment variable is too large
        if task_before:
            print("Before command finished\n" if os.environ.get("QL_LANG") == "en" else "执行前置命令结束\n")
    except Exception as error:
        print(f"\ue926 run task before error: {error}")
        if task_before:
            print("Before command finished\n" if os.environ.get("QL_LANG") == "en" else "执行前置命令结束\n")

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

    class BaseApi(Client):
        def notify(self, *args, **kwargs):
            # Most scripts never send a notification. Python caches this
            # module after the first call, including its channel dependencies.
            from __ql_notify__ import send

            return send(*args, **kwargs)

    QLAPI = BaseApi()
    builtins.QLAPI = QLAPI
except Exception as error:
    print(f"run builtin code error: {error}\n")


# A line event in the entry module occurs after interpreter startup, imports
# performed by this preload, and the configured before hook.
def observe_script_start(target, marker):
    if sys.gettrace() is not None:
        return
    def first_line(frame, event, arg):
        if event == 'line':
            import time
            try:
                with open(marker, 'x') as receipt:
                    receipt.write(str(time.time_ns() // 1000000))
            except OSError:
                pass
            sys.settrace(None)
        return first_line
    def enter(frame, event, arg):
        if event == 'call' and frame.f_code.co_name == '<module>' and os.path.realpath(frame.f_code.co_filename) == target:
            return first_line
        return None
    sys.settrace(enter)

if os.getenv('QL_SCRIPT_ENTRY') and os.getenv('QL_SCRIPT_START_FILE'):
    observe_script_start(os.environ['QL_SCRIPT_ENTRY'], os.environ['QL_SCRIPT_START_FILE'])
