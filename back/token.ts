import 'reflect-metadata';
import OpenService from './services/open';
import { Container } from 'typedi';
import LoggerInstance from './loaders/logger';
import config from './config';
import path from 'path';
import os from 'os';
import { writeFileWithLock } from './shared/utils';

const tokenFile = path.join(config.configPath, 'token.json');

async function getToken() {
  try {
    Container.set('logger', LoggerInstance);
    const openService = Container.get(OpenService);
    const appToken = await openService.generateSystemToken();
    console.log(appToken.value);
    await writeFile({
      value: appToken.value,
      expiration: appToken.expiration,
    });
  } catch (error) {
    console.log(error);
  }
}

async function writeFile(data: any) {
  await writeFileWithLock(tokenFile, `${JSON.stringify(data)}${os.EOL}`);
}

getToken();
