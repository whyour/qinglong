import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

export class ScenarioLog {
  id?: number;
  scenarioId: number;
  scenarioName?: string;
  triggerData?: any; // The data that triggered the scenario
  conditionsMatched?: boolean;
  executionStatus?: 'success' | 'failure' | 'partial';
  executionDetails?: any; // Details about actions executed
  errorMessage?: string;
  executionTime?: number; // Time taken in milliseconds
  retriesAttempted?: number;
  createdAt?: Date;

  constructor(options: ScenarioLog) {
    this.id = options.id;
    this.scenarioId = options.scenarioId;
    this.scenarioName = options.scenarioName;
    this.triggerData = options.triggerData;
    this.conditionsMatched = options.conditionsMatched;
    this.executionStatus = options.executionStatus;
    this.executionDetails = options.executionDetails;
    this.errorMessage = options.errorMessage;
    this.executionTime = options.executionTime;
    this.retriesAttempted = options.retriesAttempted || 0;
    this.createdAt = options.createdAt;
  }
}

export interface ScenarioLogInstance
  extends Model<ScenarioLog, ScenarioLog>,
    ScenarioLog {}

export const ScenarioLogModel = sequelize.define<ScenarioLogInstance>(
  'ScenarioLog',
  {
    scenarioId: {
      type: DataTypes.NUMBER,
      allowNull: false,
    },
    scenarioName: DataTypes.STRING,
    triggerData: DataTypes.JSON,
    conditionsMatched: DataTypes.BOOLEAN,
    executionStatus: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    executionDetails: DataTypes.JSON,
    errorMessage: DataTypes.TEXT,
    executionTime: DataTypes.NUMBER,
    retriesAttempted: {
      type: DataTypes.NUMBER,
      defaultValue: 0,
    },
  },
);
