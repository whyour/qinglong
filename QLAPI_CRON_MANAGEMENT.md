# QLAPI Cron Management Features

## Overview

This document describes the new cron task management capabilities added to the QLAPI (Qinglong API). These features allow scripts to interact with scheduled tasks (cron jobs) programmatically.

## New API Methods

### 1. getCrons - Query Cron Tasks

Query and search for cron tasks.

```javascript
// Get all cron tasks
QLAPI.getCrons({}).then((response) => {
  console.log('All cron tasks:', response);
  // response.code: 200 for success
  // response.data: array of cron items
});

// Search for specific cron tasks
QLAPI.getCrons({ searchValue: 'test' }).then((response) => {
  console.log('Search results:', response);
  // Returns cron tasks matching the search term
});
```

**Parameters:**
- `searchValue` (optional): String to search for in task names, commands, schedules, or labels

**Response:**
- `code`: 200 for success, 500 for error
- `data`: Array of cron items with properties:
  - `id`: Task ID
  - `name`: Task name
  - `command`: Command to execute
  - `schedule`: Cron schedule expression
  - `status`: Task status (0=idle, 1=running, 2=queued)
  - `isDisabled`: 0=enabled, 1=disabled
  - `labels`: Array of labels
  - `task_before`: Script to run before task
  - `task_after`: Script to run after task
  - Other metadata fields

### 2. getCronById - Get Cron Task by ID

Retrieve a specific cron task by its ID.

```javascript
QLAPI.getCronById({ id: 1 }).then((response) => {
  console.log('Cron task:', response);
  // response.code: 200 for success, 404 if not found
  // response.data: cron item details
}).catch((err) => {
  console.log('Error:', err);
});
```

**Parameters:**
- `id` (required): The task ID

**Response:**
- `code`: 200 for success, 400 for invalid parameters, 404 if not found
- `data`: Cron item with full details

### 3. enableCrons - Enable Cron Tasks

Enable one or more cron tasks by their IDs.

```javascript
// Enable a single task
QLAPI.enableCrons({ ids: [1] }).then((response) => {
  console.log('Task enabled:', response);
});

// Enable multiple tasks
QLAPI.enableCrons({ ids: [1, 2, 3] }).then((response) => {
  console.log('Tasks enabled:', response);
});
```

**Parameters:**
- `ids` (required): Array of task IDs to enable

**Response:**
- `code`: 200 for success, 400 for invalid parameters

### 4. disableCrons - Disable Cron Tasks

Disable one or more cron tasks by their IDs.

```javascript
// Disable a single task
QLAPI.disableCrons({ ids: [1] }).then((response) => {
  console.log('Task disabled:', response);
});

// Disable multiple tasks
QLAPI.disableCrons({ ids: [1, 2, 3] }).then((response) => {
  console.log('Tasks disabled:', response);
});
```

**Parameters:**
- `ids` (required): Array of task IDs to disable

**Response:**
- `code`: 200 for success, 400 for invalid parameters

### 5. runCrons - Manually Execute Cron Tasks

Manually trigger execution of one or more cron tasks.

```javascript
// Run a single task
QLAPI.runCrons({ ids: [1] }).then((response) => {
  console.log('Task started:', response);
});

// Run multiple tasks
QLAPI.runCrons({ ids: [1, 2, 3] }).then((response) => {
  console.log('Tasks started:', response);
});
```

**Parameters:**
- `ids` (required): Array of task IDs to run

**Response:**
- `code`: 200 for success, 400 for invalid parameters

## Use Cases

### Task Coordination

Execute tasks in sequence or based on conditions:

```javascript
// Run task 2 after task 1 completes
QLAPI.runCrons({ ids: [1] }).then(() => {
  console.log('Task 1 started');
  // You might want to poll or wait for task 1 to complete
  // before running task 2
});
```

### Conditional Task Management

Enable or disable tasks based on certain conditions:

```javascript
// Get all tasks and conditionally enable/disable them
QLAPI.getCrons({}).then((response) => {
  const tasks = response.data;
  
  tasks.forEach(task => {
    if (task.name.includes('special')) {
      // Enable special tasks
      QLAPI.enableCrons({ ids: [task.id] });
    } else {
      // Disable other tasks
      QLAPI.disableCrons({ ids: [task.id] });
    }
  });
});
```

### Task Status Monitoring

Query task status to determine what actions to take:

```javascript
QLAPI.getCronById({ id: 1 }).then((response) => {
  const task = response.data;
  
  console.log('Task name:', task.name);
  console.log('Is enabled:', task.isDisabled === 0);
  console.log('Current status:', task.status === 0 ? 'idle' : 
                                 task.status === 1 ? 'running' : 'queued');
  
  // Take action based on status
  if (task.status === 0 && task.isDisabled === 0) {
    console.log('Task is idle and enabled, ready to run');
  }
});
```

## Complete Example

See `sample/ql_sample.js` for a complete working example of all the new features.

## Notes

- All methods return Promises
- Task IDs are numeric integers
- Task status values: 0 (idle), 1 (running), 2 (queued)
- Disabled status: isDisabled = 0 (enabled), isDisabled = 1 (disabled)
- When searching with `getCrons`, the search applies to name, command, schedule, and labels
