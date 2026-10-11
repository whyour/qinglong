import { CronJob } from '../shared/cronScheduler';
import { ToadScheduler } from 'toad-scheduler';

export const scheduleStacks = new Map<string, CronJob[]>();

export const intervalSchedule = new ToadScheduler();
