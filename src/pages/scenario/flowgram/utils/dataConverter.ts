// Data format converter between Flowgram and backend
import type { FlowgramGraph, FlowgramNode, FlowgramEdge } from '../types';

/**
 * Convert Flowgram graph to backend format
 * Flowgram uses a similar node-edge structure, so minimal conversion needed
 */
export function flowgramToBackend(flowgramGraph: FlowgramGraph): any {
  return {
    nodes: flowgramGraph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
    })),
    edges: flowgramGraph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  };
}

/**
 * Convert backend format to Flowgram graph
 */
export function backendToFlowgram(backendGraph: any): FlowgramGraph {
  if (!backendGraph || !backendGraph.nodes) {
    return { nodes: [], edges: [] };
  }

  return {
    nodes: backendGraph.nodes.map((node: any) => ({
      id: node.id,
      type: node.type,
      position: node.position || { x: 0, y: 0 },
      data: node.data || {},
    })),
    edges: backendGraph.edges || [],
  };
}

/**
 * Create a new edge between two nodes
 */
export function createEdge(source: string, target: string, id?: string): FlowgramEdge {
  return {
    id: id || `edge-${source}-${target}`,
    source,
    target,
  };
}

/**
 * Validate workflow graph structure
 */
export function validateWorkflow(graph: FlowgramGraph): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for at least one node
  if (!graph.nodes || graph.nodes.length === 0) {
    errors.push('工作流至少需要一个节点');
  }

  // Check for trigger or start node
  const hasTrigger = graph.nodes.some((n) => n.type === 'trigger' || n.type === 'start');
  if (!hasTrigger) {
    errors.push('工作流需要至少一个触发器或开始节点');
  }

  // Check for cycles (simple check)
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recStack.add(nodeId);

    const outgoingEdges = graph.edges.filter((e) => e.source === nodeId);
    for (const edge of outgoingEdges) {
      if (!visited.has(edge.target)) {
        if (hasCycle(edge.target)) return true;
      } else if (recStack.has(edge.target)) {
        return true;
      }
    }

    recStack.delete(nodeId);
    return false;
  }

  for (const node of graph.nodes) {
    if (!visited.has(node.id) && hasCycle(node.id)) {
      errors.push('工作流包含循环依赖');
      break;
    }
  }

  // Check for disconnected nodes
  const connectedNodes = new Set<string>();
  graph.edges.forEach((edge) => {
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  });

  const disconnectedNodes = graph.nodes.filter(
    (node) => !connectedNodes.has(node.id) && graph.nodes.length > 1
  );

  if (disconnectedNodes.length > 0) {
    errors.push(`发现 ${disconnectedNodes.length} 个未连接的节点`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
