import { Repository, RecordRow } from './repository';

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

export type CronViewInstance = RecordRow<CrontabView>;
export const CrontabViewModel = new Repository<CrontabView>('CrontabView');
