import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

export class Scenario {
  id?: number;
  name: string;
  description?: string;
  isEnabled?: 1 | 0;
  workflowGraph?: any; // Flowgram workflow graph structure
  triggerType?: string; // Deprecated: kept for backward compatibility
  triggerConfig?: any; // Deprecated: kept for backward compatibility
  conditionLogic?: 'AND' | 'OR'; // Deprecated: kept for backward compatibility
  conditions?: any[]; // Deprecated: kept for backward compatibility
  actions?: any[]; // Deprecated: kept for backward compatibility
  retryStrategy?: {
    maxRetries: number;
    retryDelay: number; // in seconds
    backoffMultiplier?: number;
    errorTypes?: string[];
  };
  failureThreshold?: number; // Auto-disable after N consecutive failures
  consecutiveFailures?: number;
  delayExecution?: number; // Delay in seconds after trigger
  lastTriggeredAt?: Date;
  lastExecutedAt?: Date;
  executionCount?: number;
  failureCount?: number;
  successCount?: number;
  createdAt?: Date;
  updatedAt?: Date;

  constructor(options: Scenario) {
    this.id = options.id;
    this.name = options.name;
    this.description = options.description;
    this.isEnabled = options.isEnabled ?? 1;
    this.workflowGraph = options.workflowGraph || null;
    this.triggerType = options.triggerType;
    this.triggerConfig = options.triggerConfig;
    this.conditionLogic = options.conditionLogic || 'AND';
    this.conditions = options.conditions || [];
    this.actions = options.actions || [];
    this.retryStrategy = options.retryStrategy;
    this.failureThreshold = options.failureThreshold || 3;
    this.consecutiveFailures = options.consecutiveFailures || 0;
    this.delayExecution = options.delayExecution || 0;
    this.lastTriggeredAt = options.lastTriggeredAt;
    this.lastExecutedAt = options.lastExecutedAt;
    this.executionCount = options.executionCount || 0;
    this.failureCount = options.failureCount || 0;
    this.successCount = options.successCount || 0;
    this.createdAt = options.createdAt;
    this.updatedAt = options.updatedAt;
  }
}

export interface ScenarioInstance extends Model<Scenario, Scenario>, Scenario {}

export const ScenarioModel = sequelize.define<ScenarioInstance>('Scenario', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: DataTypes.TEXT,
  isEnabled: {
    type: DataTypes.NUMBER,
    defaultValue: 1,
  },
  workflowGraph: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  triggerType: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  triggerConfig: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  conditionLogic: {
    type: DataTypes.STRING,
    defaultValue: 'AND',
  },
  conditions: {
    type: DataTypes.JSON,
    defaultValue: [],
  },
  actions: {
    type: DataTypes.JSON,
    defaultValue: [],
  },
  retryStrategy: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  failureThreshold: {
    type: DataTypes.NUMBER,
    defaultValue: 3,
  },
  consecutiveFailures: {
    type: DataTypes.NUMBER,
    defaultValue: 0,
  },
  delayExecution: {
    type: DataTypes.NUMBER,
    defaultValue: 0,
  },
  lastTriggeredAt: DataTypes.DATE,
  lastExecutedAt: DataTypes.DATE,
  executionCount: {
    type: DataTypes.NUMBER,
    defaultValue: 0,
  },
  failureCount: {
    type: DataTypes.NUMBER,
    defaultValue: 0,
  },
  successCount: {
    type: DataTypes.NUMBER,
    defaultValue: 0,
  },
});
