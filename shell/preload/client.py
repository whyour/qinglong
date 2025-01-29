import subprocess
import json
import tempfile
import os
from typing import Dict, List, TypedDict, Optional
from functools import wraps


def error_handler(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except TypeError as e:
            if "missing" in str(e):
                func_name = func.__name__
                annotations = func.__annotations__
                param_type = next(
                    (t for name, t in annotations.items() if name != "return"), None
                )
                if param_type and hasattr(param_type, "__annotations__"):
                    required_fields = {
                        k: v
                        for k, v in param_type.__annotations__.items()
                        if not getattr(param_type, "__total__", True)
                        or k in getattr(param_type, "__required_keys__", set())
                    }
                    fields_str = ", ".join(
                        f'"{k}": {v.__name__}' for k, v in required_fields.items()
                    )
                    raise Exception(
                        f"{func_name}() requires a dictionary with parameters: {{{fields_str}}}"
                    ) from None
            raise Exception(f"{str(e)}") from None
        except Exception as e:
            error_msg = str(e)
            if "Error:" in error_msg:
                error_msg = error_msg.split("Error:")[-1].split("\n")[0].strip()
            raise Exception(f"{error_msg}") from None

    return wrapper


class EnvItem(TypedDict, total=False):
    id: Optional[int]
    name: Optional[str]
    value: Optional[str]
    remarks: Optional[str]
    status: Optional[int]
    position: Optional[int]


class GetEnvsParams(TypedDict, total=False):
    searchValue: str


class CreateEnvParams(TypedDict):
    envs: List[EnvItem]


class UpdateEnvParams(TypedDict):
    env: EnvItem


class DeleteEnvsParams(TypedDict):
    ids: List[int]


class MoveEnvParams(TypedDict):
    id: int
    fromIndex: int
    toIndex: int


class DisableEnvsParams(TypedDict):
    ids: List[int]


class EnableEnvsParams(TypedDict):
    ids: List[int]


class UpdateEnvNamesParams(TypedDict):
    ids: List[int]
    name: str


class GetEnvByIdParams(TypedDict):
    id: int


class SystemNotifyParams(TypedDict):
    title: str
    content: str


class EnvsResponse(TypedDict):
    code: int
    data: List[EnvItem]
    message: Optional[str]


class EnvResponse(TypedDict):
    code: int
    data: EnvItem
    message: Optional[str]


class Response(TypedDict):
    code: int
    message: Optional[str]


class ExtraScheduleItem(TypedDict, total=False):
    schedule: Optional[str]


class CronItem(TypedDict, total=False):
    id: Optional[int]
    command: Optional[str]
    schedule: Optional[str]
    name: Optional[str]
    labels: List[str]
    sub_id: Optional[int]
    extra_schedules: List[ExtraScheduleItem]
    task_before: Optional[str]
    task_after: Optional[str]
    status: Optional[int]
    log_path: Optional[str]
    pid: Optional[int]
    last_running_time: Optional[int]
    last_execution_time: Optional[int]


class CreateCronParams(TypedDict):
    command: str
    schedule: str
    name: Optional[str]
    labels: List[str]
    sub_id: Optional[int]
    extra_schedules: List[ExtraScheduleItem]
    task_before: Optional[str]
    task_after: Optional[str]


class UpdateCronParams(TypedDict):
    id: int
    command: str
    schedule: str
    name: Optional[str]
    labels: List[str]
    sub_id: Optional[int]
    extra_schedules: List[ExtraScheduleItem]
    task_before: Optional[str]
    task_after: Optional[str]


class DeleteCronsParams(TypedDict):
    ids: List[int]


class CronDetailParams(TypedDict):
    log_path: str


class CronsResponse(TypedDict):
    code: int
    data: List[CronItem]
    message: Optional[str]


class CronResponse(TypedDict):
    code: int
    data: CronItem
    message: Optional[str]


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
                    stack: error.stack,
                    name: error.name
                }}));
                process.exit(1);
            }}
        }})();
        """

        with open(self.temp_script, "w", encoding="utf-8") as f:
            f.write(node_code)

        result = subprocess.run(
            ["node", self.temp_script],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            error_data = json.loads(result.stderr)
            raise Exception(
                f"{error_data.get('name', 'Error')}: {error_data.get('stack')}"
            )

        return json.loads(result.stdout)

    @error_handler
    def getEnvs(self, params: GetEnvsParams = None) -> EnvsResponse:
        return self._execute_node("getEnvs", params)

    @error_handler
    def createEnv(self, data: CreateEnvParams) -> EnvsResponse:
        return self._execute_node("createEnv", data)

    @error_handler
    def updateEnv(self, data: UpdateEnvParams) -> EnvResponse:
        return self._execute_node("updateEnv", data)

    @error_handler
    def deleteEnvs(self, data: DeleteEnvsParams) -> Response:
        return self._execute_node("deleteEnvs", data)

    @error_handler
    def moveEnv(self, data: MoveEnvParams) -> EnvResponse:
        return self._execute_node("moveEnv", data)

    @error_handler
    def disableEnvs(self, data: DisableEnvsParams) -> Response:
        return self._execute_node("disableEnvs", data)

    @error_handler
    def enableEnvs(self, data: EnableEnvsParams) -> Response:
        return self._execute_node("enableEnvs", data)

    @error_handler
    def updateEnvNames(self, data: UpdateEnvNamesParams) -> Response:
        return self._execute_node("updateEnvNames", data)

    @error_handler
    def getEnvById(self, data: GetEnvByIdParams) -> EnvResponse:
        return self._execute_node("getEnvById", data)

    @error_handler
    def systemNotify(self, data: SystemNotifyParams) -> Response:
        return self._execute_node("systemNotify", data)

    @error_handler
    def getCronDetail(self, data: CronDetailParams) -> CronResponse:
        return self._execute_node("getCronDetail", data)

    @error_handler
    def createCron(self, data: CreateCronParams) -> CronResponse:
        return self._execute_node("createCron", data)

    @error_handler
    def updateCron(self, data: UpdateCronParams) -> CronResponse:
        return self._execute_node("updateCron", data)

    @error_handler
    def deleteCrons(self, data: DeleteCronsParams) -> Response:
        return self._execute_node("deleteCrons", data)
