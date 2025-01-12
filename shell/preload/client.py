import subprocess
import json
import tempfile
import os
from typing import Dict, List
from functools import wraps


def error_handler(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except json.JSONDecodeError as e:
            raise Exception(f"parse json error: {str(e)}")
        except subprocess.SubprocessError as e:
            raise Exception(f"node process error: {str(e)}")
        except Exception as e:
            raise Exception(f"unknown error: {str(e)}")

    return wrapper


class Client:
    def __init__(self):
        self.temp_dir = tempfile.mkdtemp(prefix="node_client_")
        self.temp_script = os.path.join(self.temp_dir, "temp_script.js")

    def __del__(self):
        try:
            if os.path.exists(self.temp_script):
                os.remove(self.temp_script)
            os.rmdir(self.temp_dir)
        except Exception:
            pass

    @error_handler
    def _execute_node(self, method: str, params: Dict = None) -> Dict:
        node_code = f"""
        const api = require('{os.getenv("QL_DIR")}/shell/preload/client.js');
        
        (async () => {{
            try {{
                const result = await api.{method}({json.dumps(params) if params else ''});
                console.log(JSON.stringify(result));
            }} catch (error) {{
                console.error(JSON.stringify({{
                    error: error.message,
                    stack: error.stack
                }}));
                process.exit(1);
            }}
        }})();
        """

        with open(self.temp_script, "w", encoding="utf-8") as f:
            f.write(node_code)

        try:
            result = subprocess.run(
                ["node", self.temp_script],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                error_data = json.loads(result.stderr)
                raise Exception(f"{error_data.get('stack')}")

            return json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            raise Exception("node process timeout")

    @error_handler
    def getEnvs(self, params: Dict = None) -> Dict:
        return self._execute_node("getEnvs", params)

    @error_handler
    def createEnv(self, data: Dict) -> Dict:
        return self._execute_node("createEnv", data)

    @error_handler
    def updateEnv(self, data: Dict) -> Dict:
        return self._execute_node("updateEnv", data)

    @error_handler
    def deleteEnvs(self, data: Dict) -> Dict:
        return self._execute_node("deleteEnvs", data)

    @error_handler
    def moveEnv(self, data: Dict) -> Dict:
        return self._execute_node("moveEnv", data)

    @error_handler
    def disableEnvs(self, data: Dict) -> Dict:
        return self._execute_node("disableEnvs", data)

    @error_handler
    def enableEnvs(self, data: Dict) -> Dict:
        return self._execute_node("enableEnvs", data)

    @error_handler
    def updateEnvNames(self, data: Dict) -> Dict:
        return self._execute_node("updateEnvNames", data)

    @error_handler
    def getEnvById(self, data: Dict) -> Dict:
        return self._execute_node("getEnvById", data)

    @error_handler
    def systemNotify(self, data: Dict) -> Dict:
        return self._execute_node("systemNotify", data)
