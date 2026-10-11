# Flowgram.ai Integration

## Overview
The workflow editor now uses the official Flowgram.ai library (@flowgram.ai/free-layout-editor) instead of a custom implementation. This provides a professional, feature-rich workflow editing experience.

## Architecture

### Components
```
FlowgramEditor (Main Component)
  ↓
FreeLayoutEditorProvider (Context)
  ↓
EditorRenderer (Canvas)
```

### Node Registries
Following Flowgram's pattern, each node type is registered with:
- `type`: Node identifier
- `info`: Display information (icon, description)
- `meta`: Visual properties (size, etc.)
- `onAdd`: Factory function to create new node instances

### Plugins Enabled
1. **FreeSnapPlugin** - Snap-to-grid for precise placement
2. **FreeLinesPlugin** - Visual connection lines between nodes
3. **FreeNodePanelPlugin** - Node addition panel
4. **MinimapPlugin** - Overview map for large workflows
5. **PanelManagerPlugin** - Panel management

## Node Types

### 1. Start Node
- Type: `start`
- Size: 120x60
- Purpose: Workflow entry point

### 2. HTTP Request Node
- Type: `http`
- Size: 280x120
- Config: url, method, headers, body

### 3. Script Execution Node
- Type: `script`
- Size: 280x120
- Config: scriptPath, scriptContent

### 4. Condition Node
- Type: `condition`
- Size: 280x120
- Config: condition expression

### 5. Delay Node
- Type: `delay`
- Size: 280x100
- Config: delayMs (milliseconds)

### 6. Loop Node
- Type: `loop`
- Size: 280x100
- Config: iterations

### 7. End Node
- Type: `end`
- Size: 120x60
- Purpose: Workflow termination

## Data Format Conversion

### From WorkflowGraph to Flowgram
```typescript
{
  nodes: workflowGraph.nodes.map(node => ({
    id: node.id,
    type: node.type,
    data: { title: node.label, ...node.config },
    position: { x: node.x || 0, y: node.y || 0 }
  })),
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 }
}
```

### From Flowgram to WorkflowGraph
```typescript
{
  nodes: flowgramData.nodes.map(node => ({
    id: node.id,
    type: node.type,
    label: node.data.title,
    x: node.position.x,
    y: node.position.y,
    config: { ...node.data }
  })),
  startNode: flowgramData.nodes[0]?.id
}
```

## Dependencies

### Core
- `@flowgram.ai/free-layout-editor@1.0.2` - Main editor
- `@flowgram.ai/runtime-interface@1.0.2` - Runtime types

### Plugins
- `@flowgram.ai/free-snap-plugin@1.0.2`
- `@flowgram.ai/free-lines-plugin@1.0.2`
- `@flowgram.ai/free-node-panel-plugin@1.0.2`
- `@flowgram.ai/minimap-plugin@1.0.2`
- `@flowgram.ai/free-container-plugin@1.0.2`
- `@flowgram.ai/free-group-plugin@1.0.2`
- `@flowgram.ai/panel-manager-plugin@1.0.2`
- `@flowgram.ai/free-stack-plugin@1.0.2`

### Utilities
- `nanoid@^3.0.0` - Unique ID generation
- `lodash-es@^4.17.21` - Utility functions

## Usage

### In Modal
```tsx
<WorkflowEditorModal
  visible={isVisible}
  workflowGraph={existingGraph}
  onOk={(graph) => saveWorkflow(graph)}
  onCancel={() => setIsVisible(false)}
/>
```

### Editor Props
```tsx
const editorProps = useEditorProps(initialData, nodeRegistries);
```

## Features

### Visual Editing
- Drag and drop nodes
- Visual connection lines
- Snap-to-grid alignment
- Pan and zoom canvas
- Minimap for navigation

### Node Management
- Add nodes via panel or toolbar
- Select and edit nodes
- Delete nodes
- Move and position freely

### Professional UX
- Smooth animations
- Responsive design
- Dark mode compatible
- Undo/redo support (via Flowgram)
- Keyboard shortcuts (via Flowgram)

## Future Enhancements

With Flowgram integration, we can easily add:
1. **Form Meta** - Detailed node configuration forms
2. **Runtime Plugin** - Execute workflows
3. **Variable Panel** - Manage workflow variables
4. **Context Menu** - Right-click actions
5. **Custom Services** - Validation, testing, etc.
6. **Shortcuts** - Custom keyboard shortcuts
7. **Container Nodes** - Group nodes together
8. **Group Nodes** - Visual grouping

## Benefits

### For Users
- Professional workflow editor
- Intuitive drag-and-drop interface
- Visual feedback
- Familiar editing patterns

### For Developers
- Maintained by Bytedance
- Active development
- Plugin ecosystem
- TypeScript support
- Comprehensive documentation

### For Product
- Future-proof architecture
- Extensible design
- Community support
- Regular updates

## References

- [Flowgram.ai Official Site](https://flowgram.ai/)
- [GitHub Repository](https://github.com/bytedance/flowgram.ai)
- [Free Layout Demo](https://flowgram.ai/examples/free-layout/free-feature-overview.html)
- [Best Practices](https://flowgram.ai/examples/free-layout/free-feature-overview.html#%E6%9C%80%E4%BD%B3%E5%AE%9E%E8%B7%B5)
