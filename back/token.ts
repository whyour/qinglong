import 'reflect-metadata';
import OpenService from './services/open';
import { Container } from 'typedi';
import LoggerInstance from './loaders/logger';
import fs from 'fs';
import config from './config';
import path from 'path';

const tokenFile = path.join(config.configPath, 'token.json');

async function getToken() {
  try {
    const data = await readFile();
    const nowTime = Math.round(Date.now() / 1000);
    if (data.value && data.expiration > nowTime) {
      console.log(data.value);
    } else {
      Container.set('logger', LoggerInstance);
      const openService = Container.get(OpenService);
      const appToken = await openService.findSystemToken();
      console.log(appToken.value);
      await writeFile({
        value: appToken.value,
        expiration: appToken.expiration,
      });
    }
  } catch (error) {
    console.log(error);
  }
}

async function readFile() {
  return new Promise<any>((resolve, reject) => {
    fs.readFile(
      path.join(config.configPath, 'token.json'),
      { encoding: 'utf8' },
      (err, data) => {
        if (err) {
          resolve({});
        } else {
          resolve(JSON.parse(data));
        }
      },
    );
  });
}

async function writeFile(data: any) {
  return new Promise<void>((resolve, reject) => {
    fs.writeFile(tokenFile, JSON.stringify(data), { encoding: 'utf8' }, () => {
      resolve();
    });
  });
}

getToken();
