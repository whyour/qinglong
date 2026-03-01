# Scenario Mode Implementation

## Overview
A complete visual workflow automation system inspired by Flowgram.ai, featuring a canvas-based workflow editor with intuitive node management.

## Features Implemented

### Backend API
- **Endpoints**: `/api/scenarios`
  - `GET /` - List scenarios with search and pagination
  - `POST /` - Create new scenario
  - `PUT /` - Update scenario
  - `DELETE /` - Delete scenarios
  - `PUT /enable` - Enable scenarios
  - `PUT /disable` - Disable scenarios
  - `GET /:id` - Get scenario by ID

### Frontend Components

#### 1. Scenario Management Page (`/scenario`)
- **List View**: Table displaying all scenarios with:
  - Scenario name, description, status
  - Workflow node count
  - Creation date
  - Batch operations (enable, disable, delete)
  - Search functionality

#### 2. Workflow Editor Modal
- **Full-screen modal** (95vw × 85vh)
- **Split Layout**:
  - **Left Canvas** (flexible width, min 600px):
    - Grid-based node cards
    - Visual node selection with highlighting
    - Toolbar with quick node addition buttons
  - **Right Edit Panel** (fixed 400px):
    - Dynamic configuration forms
    - Node-specific fields
    - Save and delete controls

#### 3. Node Types Supported
1. **HTTP Request**
   - URL, method (GET/POST/PUT/DELETE)
   - Headers (JSON format)
   - Request body

2. **Script Execution**
   - Script path
   - Inline script content

3. **Condition**
   - Conditional expression
   - Branch handling

4. **Delay**
   - Delay time in milliseconds

5. **Loop**
   - Number of iterations

## User Workflow

```
1. Navigate to "场景管理" (Scenario Management) in sidebar
   ↓
2. Click "新建场景" (New Scenario)
   ↓
3. Enter scenario name and description
   ↓
4. Click "编辑工作流" (Edit Workflow)
   ↓
5. Add nodes by clicking toolbar buttons
   ↓
6. Click node to configure in right panel
   ↓
7. Configure node parameters
   ↓
8. Click "保存工作流" (Save Workflow)
   ↓
9. Enable scenario to activate
```

## Technical Architecture

### Data Model
```typescript
interface Scenario {
  id?: number;
  name: string;
  description?: string;
  status?: 0 | 1; // 0: disabled, 1: enabled
  workflowGraph?: WorkflowGraph;
  createdAt?: Date;
  updatedAt?: Date;
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  startNode?: string;
}

interface WorkflowNode {
  id: string;
  type: 'http' | 'script' | 'condition' | 'delay' | 'loop';
  label: string;
  x?: number;
  y?: number;
  config: {...};
  next?: string | string[];
}
```

### Layout Design
- **Flexbox-based responsive layout**
- **Desktop**: Side-by-side canvas and edit panel
- **Mobile**: Stacked layout (50% height each)
- **Theme Support**: Light and dark mode

### Internationalization
- Full Chinese (zh-CN) support
- Full English (en-US) support
- 50+ translated terms

## UI Screenshots

The workflow editor follows Flowgram.ai design principles:
- **Clean visual hierarchy**
- **Compact node cards** on canvas
- **Focused editing panel** for detailed configuration
- **Quick access toolbar** for node creation
- **Visual feedback** for selection and hover states

## Database Schema

SQLite table: `Scenarios`
- `id` (INTEGER, PRIMARY KEY)
- `name` (STRING, NOT NULL)
- `description` (TEXT)
- `status` (INTEGER, DEFAULT 0)
- `workflowGraph` (JSON)
- `createdAt` (DATETIME)
- `updatedAt` (DATETIME)

## Files Added

### Backend
- `back/data/scenario.ts` - Data model
- `back/services/scenario.ts` - Business logic
- `back/api/scenario.ts` - API routes

### Frontend
- `src/pages/scenario/index.tsx` - Main page
- `src/pages/scenario/index.less` - Page styles
- `src/pages/scenario/modal.tsx` - Create/Edit modal
- `src/pages/scenario/workflowEditorModal.tsx` - Workflow editor
- `src/pages/scenario/workflowEditor.less` - Editor styles
- `src/pages/scenario/type.ts` - TypeScript types

### Configuration
- `src/layouts/defaultProps.tsx` - Navigation menu (added scenario route)
- `src/locales/zh-CN.json` - Chinese translations
- `src/locales/en-US.json` - English translations

## Next Steps (Future Enhancements)

1. **Visual Connections**: Draw lines between nodes to show workflow flow
2. **Drag and Drop**: Allow repositioning nodes on canvas
3. **Node Execution**: Implement backend workflow execution engine
4. **Real-time Monitoring**: Show execution status and logs
5. **Templates**: Pre-built workflow templates
6. **Export/Import**: Share workflows as JSON
7. **Validation**: Advanced workflow validation rules
8. **History**: Version control for workflows
