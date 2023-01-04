import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

export enum CronViewType {
  '系统' = 1,
  '个人',
}

interface SortType {
  type: 'ASC' | 'DESC';
  value: string;
}

interface FilterType {
  property: string;
  operation: string;
  value: string;
}

export class CrontabView {
  name?: string;
  id?: number;
  position?: number;
  isDisabled?: 1 | 0;
  filters?: FilterType[];
  sorts?: SortType[];
  filterRelation?: 'and' | 'or';
  type?: CronViewType;

  constructor(options: CrontabView) {
    this.name = options.name;
    this.id = options.id;
    this.position = options.position;
    this.isDisabled = options.isDisabled || 0;
    this.filters = options.filters;
    this.sorts = options.sorts;
    this.filterRelation = options.filterRelation;
    this.type = options.type || CronViewType.个人;
  }
}

interface CronViewInstance
  extends Model<CrontabView, CrontabView>,
    CrontabView {}
export const CrontabViewModel = sequelize.define<CronViewInstance>(
  'CrontabView',
  {
    name: {
      unique: 'name',
      type: DataTypes.STRING,
    },
    position: DataTypes.NUMBER,
    isDisabled: DataTypes.NUMBER,
    filters: DataTypes.JSON,
    sorts: DataTypes.JSON,
    filterRelation: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    type: DataTypes.NUMBER,
  },
);
