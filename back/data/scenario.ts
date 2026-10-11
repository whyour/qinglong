import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

export interface WorkflowNode {
  id: string;
  type: string;
  data?: Record<string, any>;
  blocks?: WorkflowNode[];
  [key: string]: any;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  [key: string]: any;
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

export interface ScenarioInstance extends Model<Scenario, Scenario>, Scenario {}

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
