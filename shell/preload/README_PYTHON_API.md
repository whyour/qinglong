# Qinglong Python API (QLAPI) Documentation

## Overview

The Qinglong Python API provides a convenient way to interact with the Qinglong system from Python scripts. The `QLAPI` object is automatically available in your Python scripts when they run within the Qinglong environment.

## Availability

The Python QLAPI is available starting from **version 2.8.0+**. If you're using an older version (e.g., v2.7.11), please upgrade to access these features.

## Prerequisites

- Qinglong version 2.8.0 or higher
- Python 3.6 or higher
- Running within Qinglong environment (scripts executed through Qinglong task system)

## Usage

The `QLAPI` object is automatically injected into your Python script's global namespace. You don't need to import anything - just use it directly:

```python
# QLAPI is automatically available
result = QLAPI.getEnvs({"searchValue": "USER"})
print(result)
```

## Available Methods

### Environment Variables Management

#### getEnvs
Get environment variables with optional search filter.

```python
# Get all environment variables
envs = QLAPI.getEnvs()

# Search for specific environment variables
envs = QLAPI.getEnvs({"searchValue": "USER"})
```

**Parameters:**
- `searchValue` (optional): String to search for in environment variable names or values

**Returns:** `EnvsResponse` with list of environment variables

#### createEnv
Create new environment variables.

```python
result = QLAPI.createEnv({
    "envs": [
        {
            "name": "MY_VAR",
            "value": "my_value",
            "remarks": "My custom variable"
        }
    ]
})
```

**Parameters:**
- `envs`: List of environment variable objects to create

**Returns:** `EnvsResponse`

#### updateEnv
Update an existing environment variable.

```python
result = QLAPI.updateEnv({
    "env": {
        "id": 123,
        "name": "MY_VAR",
        "value": "new_value",
        "remarks": "Updated variable"
    }
})
```

**Parameters:**
- `env`: Environment variable object with id and updated fields

**Returns:** `EnvResponse`

#### deleteEnvs
Delete environment variables by IDs.

```python
result = QLAPI.deleteEnvs({"ids": [123, 456]})
```

**Parameters:**
- `ids`: List of environment variable IDs to delete

**Returns:** `Response`

#### enableEnvs
Enable environment variables.

```python
result = QLAPI.enableEnvs({"ids": [123, 456]})
```

**Parameters:**
- `ids`: List of environment variable IDs to enable

**Returns:** `Response`

#### disableEnvs
Disable environment variables.

```python
result = QLAPI.disableEnvs({"ids": [123, 456]})
```

**Parameters:**
- `ids`: List of environment variable IDs to disable

**Returns:** `Response`

#### updateEnvNames
Update names of multiple environment variables.

```python
result = QLAPI.updateEnvNames({
    "ids": [123, 456],
    "name": "NEW_NAME"
})
```

**Parameters:**
- `ids`: List of environment variable IDs
- `name`: New name to set

**Returns:** `Response`

#### getEnvById
Get a specific environment variable by ID.

```python
env = QLAPI.getEnvById({"id": 123})
```

**Parameters:**
- `id`: Environment variable ID

**Returns:** `EnvResponse`

#### moveEnv
Change the position/order of an environment variable.

```python
result = QLAPI.moveEnv({
    "id": 123,
    "fromIndex": 0,
    "toIndex": 5
})
```

**Parameters:**
- `id`: Environment variable ID
- `fromIndex`: Current position index
- `toIndex`: Target position index

**Returns:** `EnvResponse`

### Scheduled Tasks (Cron) Management

#### getCronDetail
Get details of a scheduled task.

```python
cron = QLAPI.getCronDetail({"log_path": "/path/to/log"})
```

**Parameters:**
- `log_path`: Path to the task log file

**Returns:** `CronResponse`

#### createCron
Create a new scheduled task.

```python
result = QLAPI.createCron({
    "command": "node script.js",
    "schedule": "0 0 * * *",
    "name": "Daily Task",
    "labels": ["tag1", "tag2"],
    "sub_id": None,
    "extra_schedules": [],
    "task_before": "",
    "task_after": ""
})
```

**Parameters:**
- `command`: Command to execute
- `schedule`: Cron expression
- `name`: Task name (optional)
- `labels`: List of labels (optional)
- Other optional fields

**Returns:** `CronResponse`

#### updateCron
Update an existing scheduled task.

```python
result = QLAPI.updateCron({
    "id": 123,
    "command": "node updated_script.js",
    "schedule": "0 0 * * *",
    "name": "Updated Task",
    "labels": [],
    "sub_id": None,
    "extra_schedules": [],
    "task_before": "",
    "task_after": ""
})
```

**Returns:** `CronResponse`

#### deleteCrons
Delete scheduled tasks by IDs.

```python
result = QLAPI.deleteCrons({"ids": [123, 456]})
```

**Parameters:**
- `ids`: List of task IDs to delete

**Returns:** `Response`

### Notifications

#### notify
Send a notification using configured notification channels.

```python
result = QLAPI.notify("Notification Title", "Notification Content")
```

**Parameters:**
- First argument: Notification title
- Second argument: Notification content

**Returns:** Notification result

#### systemNotify
Send a system notification with custom parameters.

```python
result = QLAPI.systemNotify({
    "title": "System Alert",
    "content": "This is a system notification"
})
```

**Parameters:**
- `title`: Notification title
- `content`: Notification content

**Returns:** `Response`

## Complete Example

```python
"""
Example Qinglong Python script demonstrating QLAPI usage
"""

# Get environment variables
print("Fetching environment variables...")
envs = QLAPI.getEnvs({"searchValue": "TOKEN"})
print(f"Found {len(envs.get('data', []))} environment variables")

# Create a new environment variable
print("Creating new environment variable...")
result = QLAPI.createEnv({
    "envs": [
        {
            "name": "MY_TEST_VAR",
            "value": "test_value_123",
            "remarks": "Created by script"
        }
    ]
})
print(f"Create result: {result}")

# Send notification
print("Sending notification...")
QLAPI.notify("Script Completed", "The script has finished executing successfully")

# Send system notification
QLAPI.systemNotify({
    "title": "Task Report",
    "content": f"Processed {len(envs.get('data', []))} environment variables"
})

print("Done!")
```

## Error Handling

All QLAPI methods may raise exceptions if there are errors communicating with the backend. It's recommended to use try-except blocks:

```python
try:
    envs = QLAPI.getEnvs({"searchValue": "USER"})
    print(f"Success: {envs}")
except Exception as e:
    print(f"Error: {e}")
    QLAPI.notify("Script Error", str(e))
```

## Troubleshooting

### AttributeError: 'BaseApi' object has no attribute 'getEnvs'

This error occurs when using an older version of Qinglong (before v2.8.0). Solutions:

1. **Upgrade Qinglong**: Update to version 2.8.0 or higher
2. **Check Installation**: Ensure `shell/preload/client.py` exists
3. **Verify Environment**: Make sure scripts are running within Qinglong environment

### Module Import Errors

The QLAPI is only available when scripts run within the Qinglong environment. If you're testing locally, you won't have access to QLAPI.

## Technical Details

The Python QLAPI is a wrapper around the Node.js gRPC API client. When you call a method like `QLAPI.getEnvs()`:

1. Python Client creates a temporary Node.js script
2. Executes the corresponding Node.js API method
3. Returns the JSON result back to Python

This architecture ensures consistency between JavaScript and Python APIs.

## See Also

For more information and examples:

- [JavaScript API Client Source](./client.js) - The underlying Node.js gRPC client
- [Python Sample Script](../../sample/ql_sample.py) - Example Python script using QLAPI
- [JavaScript Sample Script](../../sample/ql_sample.js) - Example JavaScript script for comparison

These files are located in the Qinglong repository under `shell/preload/` and `sample/` directories.
