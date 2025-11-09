// Graph Execution Engine for Visual Workflow
import winston from 'winston';

interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: any;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface ExecutionContext {
  triggerData: any;
  variables: Map<string, any>;
  executedNodes: Set<string>;
  results: Map<string, any>;
}

export class GraphExecutor {
  private logger: winston.Logger;

  constructor(logger: winston.Logger) {
    this.logger = logger;
  }

  /**
   * Execute a workflow graph
   */
  public async executeGraph(
    workflowGraph: WorkflowGraph,
    triggerData: any,
    executor: any, // ScenarioService instance
  ): Promise<{ success: boolean; results: any; executedNodes: string[] }> {
    const context: ExecutionContext = {
      triggerData,
      variables: new Map(),
      executedNodes: new Set(),
      results: new Map(),
    };

    try {
      // Find trigger nodes (entry points)
      const triggerNodes = workflowGraph.nodes.filter(
        (node) => node.type === 'trigger',
      );

      if (triggerNodes.length === 0) {
        throw new Error('No trigger node found in workflow');
      }

      // Execute from each trigger node
      for (const triggerNode of triggerNodes) {
        await this.executeNode(
          triggerNode,
          workflowGraph,
          context,
          executor,
        );
      }

      return {
        success: true,
        results: Object.fromEntries(context.results),
        executedNodes: Array.from(context.executedNodes),
      };
    } catch (error: any) {
      this.logger.error('Graph execution failed:', error);
      return {
        success: false,
        results: { error: error.message },
        executedNodes: Array.from(context.executedNodes),
      };
    }
  }

  /**
   * Execute a single node and its connected nodes
   */
  private async executeNode(
    node: WorkflowNode,
    graph: WorkflowGraph,
    context: ExecutionContext,
    executor: any,
  ): Promise<any> {
    // Skip if already executed
    if (context.executedNodes.has(node.id)) {
      return context.results.get(node.id);
    }

    this.logger.info(`Executing node: ${node.id} (${node.type})`);
    context.executedNodes.add(node.id);

    let result: any = null;

    try {
      // Execute based on node type
      switch (node.type) {
        case 'trigger':
          result = await this.executeTriggerNode(node, context, executor);
          break;
        case 'condition':
          result = await this.executeConditionNode(node, context, executor);
          break;
        case 'action':
          result = await this.executeActionNode(node, context, executor);
          break;
        case 'control':
          result = await this.executeControlNode(node, context, executor);
          break;
        case 'logic_gate':
          result = await this.executeLogicGateNode(node, context, executor);
          break;
        default:
          this.logger.warn(`Unknown node type: ${node.type}`);
          result = { skipped: true };
      }

      context.results.set(node.id, result);

      // Find and execute next nodes
      const nextEdges = graph.edges.filter((edge) => edge.source === node.id);
      
      for (const edge of nextEdges) {
        const nextNode = graph.nodes.find((n) => n.id === edge.target);
        if (nextNode) {
          await this.executeNode(nextNode, graph, context, executor);
        }
      }

      return result;
    } catch (error: any) {
      this.logger.error(`Node execution failed: ${node.id}`, error);
      context.results.set(node.id, { error: error.message });
      throw error;
    }
  }

  private async executeTriggerNode(
    node: WorkflowNode,
    context: ExecutionContext,
    executor: any,
  ): Promise<any> {
    // Trigger nodes just pass through the trigger data
    return { triggered: true, data: context.triggerData };
  }

  private async executeConditionNode(
    node: WorkflowNode,
    context: ExecutionContext,
    executor: any,
  ): Promise<any> {
    const { field, operator, value } = node.data;
    
    // Get field value from trigger data or variables
    let fieldValue = this.getFieldValue(field, context);

    // Evaluate condition
    const matched = this.evaluateCondition(fieldValue, operator, value);

    this.logger.info(
      `Condition ${node.id}: ${field} ${operator} ${value} = ${matched}`,
    );

    return { matched, fieldValue, expectedValue: value };
  }

  private async executeActionNode(
    node: WorkflowNode,
    context: ExecutionContext,
    executor: any,
  ): Promise<any> {
    const { actionType } = node.data;

    switch (actionType) {
      case 'run_task':
        return await executor.executeRunTask(node.data);
      case 'set_variable':
        return await executor.executeSetVariable(node.data);
      case 'execute_command':
        return await executor.executeCommand(node.data);
      case 'send_notification':
        return await executor.executeSendNotification(node.data);
      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }
  }

  private async executeControlNode(
    node: WorkflowNode,
    context: ExecutionContext,
    executor: any,
  ): Promise<any> {
    const { controlType } = node.data;

    switch (controlType) {
      case 'delay':
        const delayMs = (node.data.delaySeconds || 0) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { delayed: delayMs };
      case 'retry':
        // Retry logic handled by caller
        return { retryConfig: node.data };
      case 'circuit_breaker':
        // Circuit breaker logic handled by caller
        return { circuitBreakerConfig: node.data };
      default:
        throw new Error(`Unknown control type: ${controlType}`);
    }
  }

  private async executeLogicGateNode(
    node: WorkflowNode,
    context: ExecutionContext,
    executor: any,
  ): Promise<any> {
    const { gateType } = node.data;
    // Logic gates are evaluated by checking incoming edges
    return { gateType, passed: true };
  }

  private getFieldValue(field: string, context: ExecutionContext): any {
    // Support dot notation for nested fields
    const parts = field.split('.');
    let value: any = context.triggerData;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        // Check variables
        if (context.variables.has(field)) {
          return context.variables.get(field);
        }
        return undefined;
      }
    }

    return value;
  }

  private evaluateCondition(
    fieldValue: any,
    operator: string,
    expectedValue: any,
  ): boolean {
    switch (operator) {
      case 'equals':
        return fieldValue == expectedValue;
      case 'not_equals':
        return fieldValue != expectedValue;
      case 'greater_than':
        return Number(fieldValue) > Number(expectedValue);
      case 'less_than':
        return Number(fieldValue) < Number(expectedValue);
      case 'contains':
        return String(fieldValue).includes(String(expectedValue));
      case 'not_contains':
        return !String(fieldValue).includes(String(expectedValue));
      default:
        this.logger.warn(`Unknown operator: ${operator}`);
        return false;
    }
  }

  /**
   * Validate a workflow graph
   */
  public validateGraph(workflowGraph: WorkflowGraph): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check for at least one trigger node
    const triggerNodes = workflowGraph.nodes.filter(
      (node) => node.type === 'trigger',
    );
    if (triggerNodes.length === 0) {
      errors.push('Workflow must have at least one trigger node');
    }

    // Check for cycles (simple check)
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      const outgoingEdges = workflowGraph.edges.filter(
        (edge) => edge.source === nodeId,
      );

      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          if (hasCycle(edge.target)) {
            return true;
          }
        } else if (recursionStack.has(edge.target)) {
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    for (const node of workflowGraph.nodes) {
      if (!visited.has(node.id) && hasCycle(node.id)) {
        errors.push('Workflow contains cycles');
        break;
      }
    }

    // Check for disconnected nodes (excluding triggers)
    const connectedNodes = new Set<string>();
    workflowGraph.edges.forEach((edge) => {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    });

    const disconnectedNodes = workflowGraph.nodes.filter(
      (node) =>
        node.type !== 'trigger' && !connectedNodes.has(node.id),
    );

    if (disconnectedNodes.length > 0) {
      errors.push(
        `Disconnected nodes found: ${disconnectedNodes.map((n) => n.id).join(', ')}`,
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
