import 'reflect-metadata';
import OpenService from './services/open';
import { Container } from 'typedi';
import LoggerInstance from './loaders/logger';

async function getToken() {
  try {
    Container.set('logger', LoggerInstance);
    const openService = Container.get(OpenService);
    const appToken = await openService.generateSystemToken(
      process.argv.includes('--renew'),
    );
    console.log(appToken.value);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

getToken();
