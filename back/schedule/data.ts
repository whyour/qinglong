import nodeSchedule from 'node-schedule';
import { ToadScheduler } from 'toad-scheduler';

export const scheduleStacks = new Map<string, nodeSchedule.Job[]>();

export const intervalSchedule = new ToadScheduler();
