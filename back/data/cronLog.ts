import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

export class CronLog {
  id?: number;
  cron_id: number;
  cron_name: string;
  start_time: number;
  duration: number;

  constructor(options: CronLog) {
    this.cron_id = options.cron_id;
    this.cron_name = options.cron_name;
    this.start_time = options.start_time;
    this.duration = options.duration;
  }
}

export interface CronLogInstance extends Model<CronLog, CronLog>, CronLog {}
export const CronLogModel = sequelize.define<CronLogInstance>(
  'CronLog',
  {
    cron_id: DataTypes.NUMBER,
    cron_name: DataTypes.STRING,
    start_time: DataTypes.NUMBER,
    duration: DataTypes.NUMBER,
  },
  {
    indexes: [{ fields: ['cron_id'] }, { fields: ['start_time'] }],
  },
);
