import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

interface WorkflowNode {
  id: string;
  type: 'http' | 'script' | 'condition' | 'delay' | 'loop';
  label: string;
  x?: number;
  y?: number;
  config: {
    // HTTP Request node
    url?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
    
    // Script node
    scriptId?: number;
    scriptPath?: string;
    scriptContent?: string;
    
    // Condition node
    condition?: string;
    trueNext?: string;
    falseNext?: string;
    
    // Delay node
    delayMs?: number;
    
    // Loop node
    iterations?: number;
    loopBody?: string[];
  };
  next?: string | string[]; // ID(s) of next node(s)
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  startNode?: string;
}

export class Scenario {
  name?: string;
  description?: string;
  id?: number;
  status?: 0 | 1; // 0: disabled, 1: enabled
  workflowGraph?: WorkflowGraph;
  createdAt?: Date;
  updatedAt?: Date;

  constructor(options: Scenario) {
    this.name = options.name;
    this.description = options.description;
    this.id = options.id;
    this.status = options.status || 0;
    this.workflowGraph = options.workflowGraph;
    this.createdAt = options.createdAt;
    this.updatedAt = options.updatedAt;
  }
}

export interface ScenarioInstance
  extends Model<Scenario, Scenario>,
    Scenario {}

export const ScenarioModel = sequelize.define<ScenarioInstance>(
  'Scenario',
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    workflowGraph: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    timestamps: true,
  },
);
