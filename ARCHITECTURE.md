# Scenario Mode - Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Qinglong Application                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────┐         ┌─────────────────────┐           │
│  │   Navigation Menu   │         │   API Layer         │           │
│  │  ┌──────────────┐   │         │  /api/scenarios/    │           │
│  │  │ 定时任务     │   │         │   - GET    (list)   │           │
│  │  │ 订阅管理     │   │         │   - POST   (create) │           │
│  │  │ 场景管理 ⭐  │◄──┼─────────┤   - PUT    (update) │           │
│  │  │ 环境变量     │   │         │   - DELETE (delete) │           │
│  │  │ ...          │   │         │   - PUT /enable     │           │
│  │  └──────────────┘   │         │   - PUT /disable    │           │
│  └─────────────────────┘         │   - GET /:id        │           │
│                                   └─────────────────────┘           │
│                                              │                       │
│                                              ▼                       │
│  ┌──────────────────────────────────────────────────────┐          │
│  │              Scenario Management Page                 │          │
│  │  /scenario                                            │          │
│  │  ┌────────────────────────────────────────────────┐  │          │
│  │  │ Toolbar:                                       │  │          │
│  │  │  [新建场景] [启用] [禁用] [删除]    [搜索]    │  │          │
│  │  └────────────────────────────────────────────────┘  │          │
│  │  ┌────────────────────────────────────────────────┐  │          │
│  │  │ Table:                                         │  │          │
│  │  │ ┌─────┬────────┬──────┬──────┬────────────┐  │  │          │
│  │  │ │名称 │描述    │状态  │节点数│操作        │  │  │          │
│  │  │ ├─────┼────────┼──────┼──────┼────────────┤  │  │          │
│  │  │ │场景1│...     │启用  │5节点 │[编辑工作流]│  │  │          │
│  │  │ │场景2│...     │禁用  │3节点 │[编辑工作流]│  │  │          │
│  │  │ └─────┴────────┴──────┴──────┴────────────┘  │  │          │
│  │  └────────────────────────────────────────────────┘  │          │
│  └──────────────────────────────────────────────────────┘          │
│                              │                                       │
│                              │ Click "编辑工作流"                   │
│                              ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │         Workflow Editor Modal (Full Screen)                   │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │ Canvas Area (Left)          │ Edit Panel (Right 400px) │  │  │
│  │  ├─────────────────────────────┼──────────────────────────┤  │  │
│  │  │ Toolbar:                    │ Node Configuration       │  │  │
│  │  │ [+HTTP] [+Script]          │ ┌────────────────────┐   │  │  │
│  │  │ [+Condition] [+Delay]       │ │ Label: [______]    │   │  │  │
│  │  │ [+Loop] [Validate]          │ │ Type:  [HTTP▼]     │   │  │  │
│  │  │                             │ │                    │   │  │  │
│  │  │ Nodes Grid:                 │ │ URL:   [______]    │   │  │  │
│  │  │ ┌──────┐ ┌──────┐ ┌──────┐ │ │ Method:[GET ▼]     │   │  │  │
│  │  │ │Node 1│ │Node 2│ │Node 3│ │ │ Headers:[____]     │   │  │  │
│  │  │ │HTTP  │ │Script│ │Cond. │ │ │ Body:   [____]     │   │  │  │
│  │  │ └──────┘ └──────┘ └──────┘ │ │                    │   │  │  │
│  │  │ ┌──────┐ ┌──────┐         │ │ [Save] [Delete]     │   │  │  │
│  │  │ │Node 4│ │Node 5│         │ └────────────────────┘   │  │  │
│  │  │ │Delay │ │Loop  │         │                          │  │  │
│  │  │ └──────┘ └──────┘         │                          │  │  │
│  │  └─────────────────────────────┴──────────────────────────┘  │  │
│  │  [Cancel]                                   [Save Workflow]  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │
       │ 1. Navigate to /scenario
       ▼
┌─────────────────┐
│  Scenario Page  │
│  (React)        │
└──────┬──────────┘
       │
       │ 2. GET /api/scenarios
       ▼
┌─────────────────┐
│  Scenario API   │
│  (Express)      │
└──────┬──────────┘
       │
       │ 3. Query database
       ▼
┌─────────────────┐
│ Scenario Model  │
│  (Sequelize)    │
└──────┬──────────┘
       │
       │ 4. Read from SQLite
       ▼
┌─────────────────┐
│  Database.db    │
│  Scenarios      │
│  Table          │
└─────────────────┘
```

## Workflow Editor Data Flow

```
User Action Flow:
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Click "编辑工作流"                                          │
│          │                                                   │
│          ▼                                                   │
│  Open WorkflowEditorModal                                    │
│          │                                                   │
│          ├──► Load existing workflowGraph                    │
│          │    (if scenario has one)                         │
│          │                                                   │
│          ▼                                                   │
│  Display Canvas & Edit Panel                                 │
│          │                                                   │
│          ├──► Click [+HTTP] button                          │
│          │    └──► Create new HTTP node                     │
│          │         └──► Add to localGraph.nodes             │
│          │                                                   │
│          ├──► Click node card                               │
│          │    └──► Set selectedNodeId                       │
│          │         └──► Populate form in Edit Panel         │
│          │                                                   │
│          ├──► Edit form fields                              │
│          │    └──► Update node.config                       │
│          │         └──► Save to localGraph                  │
│          │                                                   │
│          ├──► Click [Delete] button                         │
│          │    └──► Remove node from localGraph.nodes        │
│          │                                                   │
│          ▼                                                   │
│  Click "保存工作流"                                          │
│          │                                                   │
│          ├──► Validate workflow                             │
│          │    └──► Check nodes.length > 0                   │
│          │                                                   │
│          ▼                                                   │
│  Call onOk(localGraph)                                       │
│          │                                                   │
│          ▼                                                   │
│  PUT /api/scenarios                                          │
│          │                                                   │
│          └──► Update scenario.workflowGraph                  │
│               └──► Save to database                          │
│                    └──► Success message                      │
│                         └──► Close modal                     │
│                              └──► Refresh list               │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Node Type Configurations

```
┌─────────────────────────────────────────────────────────────┐
│                      Node Types                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. HTTP Request Node                                        │
│     ┌──────────────────────────────────────────┐            │
│     │ type: 'http'                             │            │
│     │ config:                                  │            │
│     │   - url: string                          │            │
│     │   - method: GET|POST|PUT|DELETE          │            │
│     │   - headers: Record<string, string>      │            │
│     │   - body: string                         │            │
│     └──────────────────────────────────────────┘            │
│                                                              │
│  2. Script Execution Node                                    │
│     ┌──────────────────────────────────────────┐            │
│     │ type: 'script'                           │            │
│     │ config:                                  │            │
│     │   - scriptPath: string                   │            │
│     │   - scriptContent: string                │            │
│     └──────────────────────────────────────────┘            │
│                                                              │
│  3. Condition Node                                           │
│     ┌──────────────────────────────────────────┐            │
│     │ type: 'condition'                        │            │
│     │ config:                                  │            │
│     │   - condition: string                    │            │
│     │   - trueNext: string                     │            │
│     │   - falseNext: string                    │            │
│     └──────────────────────────────────────────┘            │
│                                                              │
│  4. Delay Node                                               │
│     ┌──────────────────────────────────────────┐            │
│     │ type: 'delay'                            │            │
│     │ config:                                  │            │
│     │   - delayMs: number                      │            │
│     └──────────────────────────────────────────┘            │
│                                                              │
│  5. Loop Node                                                │
│     ┌──────────────────────────────────────────┐            │
│     │ type: 'loop'                             │            │
│     │ config:                                  │            │
│     │   - iterations: number                   │            │
│     │   - loopBody: string[]                   │            │
│     └──────────────────────────────────────────┘            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema

```
Table: Scenarios
┌──────────────┬──────────────┬──────────────┬───────────────┐
│ Column       │ Type         │ Nullable     │ Default       │
├──────────────┼──────────────┼──────────────┼───────────────┤
│ id           │ INTEGER      │ NO           │ AUTO_INCREMENT│
│ name         │ STRING       │ NO           │ -             │
│ description  │ TEXT         │ YES          │ NULL          │
│ status       │ INTEGER      │ YES          │ 0             │
│ workflowGraph│ JSON         │ YES          │ NULL          │
│ createdAt    │ DATETIME     │ NO           │ NOW()         │
│ updatedAt    │ DATETIME     │ NO           │ NOW()         │
└──────────────┴──────────────┴──────────────┴───────────────┘

workflowGraph JSON structure:
{
  "nodes": [
    {
      "id": "node_1234567890",
      "type": "http",
      "label": "HTTP请求 1",
      "x": 100,
      "y": 100,
      "config": {
        "url": "https://api.example.com",
        "method": "GET",
        "headers": {},
        "body": ""
      },
      "next": "node_1234567891"
    }
  ],
  "startNode": "node_1234567890"
}
```

## Component Hierarchy

```
App
└── Layout
    └── Scenario Page (/scenario)
        ├── Toolbar
        │   ├── Button (新建场景)
        │   ├── Button (启用)
        │   ├── Button (禁用)
        │   ├── Button (删除)
        │   └── Search (搜索场景)
        ├── Table
        │   └── Columns
        │       ├── 场景名称
        │       ├── 场景描述
        │       ├── 状态
        │       ├── 工作流
        │       ├── 创建时间
        │       └── 操作
        │           └── Button (编辑工作流)
        ├── ScenarioModal
        │   └── Form
        │       ├── Input (名称)
        │       └── TextArea (描述)
        └── WorkflowEditorModal
            ├── Canvas (Left)
            │   ├── Toolbar
            │   │   ├── Button (+ HTTP)
            │   │   ├── Button (+ Script)
            │   │   ├── Button (+ Condition)
            │   │   ├── Button (+ Delay)
            │   │   ├── Button (+ Loop)
            │   │   └── Button (Validate)
            │   └── Nodes Grid
            │       └── NodeCard (×N)
            │           ├── Type Badge
            │           └── Label
            └── Edit Panel (Right)
                └── Form (Dynamic)
                    ├── Input (Label)
                    ├── Select (Type)
                    ├── [Node-specific fields]
                    └── Buttons
                        ├── Save
                        └── Delete
```

## File Organization

```
qinglong/
├── back/
│   ├── api/
│   │   ├── index.ts              (modified: +scenario route)
│   │   └── scenario.ts           (new: API endpoints)
│   ├── data/
│   │   └── scenario.ts           (new: Model definition)
│   └── services/
│       └── scenario.ts           (new: Business logic)
├── src/
│   ├── layouts/
│   │   └── defaultProps.tsx      (modified: +scenario nav)
│   ├── locales/
│   │   ├── zh-CN.json           (modified: +53 keys)
│   │   └── en-US.json           (modified: +53 keys)
│   └── pages/
│       └── scenario/
│           ├── index.tsx         (new: Main page)
│           ├── index.less        (new: Page styles)
│           ├── modal.tsx         (new: Create/Edit modal)
│           ├── workflowEditorModal.tsx (new: Editor)
│           ├── workflowEditor.less     (new: Editor styles)
│           └── type.ts           (new: TypeScript types)
└── SCENARIO_MODE.md              (new: Documentation)
```
