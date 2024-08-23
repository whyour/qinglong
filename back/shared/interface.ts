import { Dependence } from '../data/dependence';
import { ICron } from '../protos/cron';

export type Override<
  T,
  K extends Partial<{ [P in keyof T]: any }> | string,
> = K extends string
  ? Omit<T, K> & { [P in keyof T]: T[P] | unknown }
  : Omit<T, keyof K> & K;

export type TCron = Override<Partial<ICron>, { id: string }>;

export interface IDependencyFn<T> {
  (): Promise<T>;
  dependency?: Dependence;
}

export interface ICronFn<T> {
  (): Promise<T>;
  cron?: TCron;
}

export interface ISchedule {
  schedule?: string;
  name?: string;
  command?: string;
  id: string;
}

export interface IScheduleFn<T> {
  (): Promise<T>;
  schedule?: ISchedule;
}
