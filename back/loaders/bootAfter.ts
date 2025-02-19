import Container from 'typedi';
import CronService from '../services/cron';

export default async () => {
  const cronService = Container.get(CronService);

  await cronService.bootTask();
};
