import { Service, Inject } from 'typedi';
import winston from 'winston';
import fs from 'fs';
import os from 'os';
import path from 'path';

@Service()
export default class SshKeyService {
  private homedir = os.homedir();
  private sshPath = path.resolve(this.homedir, '.ssh');
  private sshConfigFilePath = path.resolve(this.sshPath, 'config');

  constructor(@Inject('logger') private logger: winston.Logger) {}

  private generatePrivateKeyFile(alias: string, key: string): void {
    try {
      fs.writeFileSync(`${this.sshPath}/${alias}`, key, {
        encoding: 'utf8',
        mode: '400',
      });
    } catch (error) {
      this.logger.error('生成私钥文件失败', error);
    }
  }

  private removePrivateKeyFile(alias: string): void {
    try {
      fs.unlinkSync(`${this.sshPath}/${alias}`);
    } catch (error) {
      this.logger.error('删除私钥文件失败', error);
    }
  }

  private generateSingleSshConfig(alias: string, host: string): string {
    return `\nHost ${alias}\n    Hostname ${host}\n    IdentityFile ${this.sshPath}/${alias}\n    StrictHostKeyChecking no`;
  }

  private generateSshConfig(configs: string[]) {
    try {
      for (const config of configs) {
        fs.appendFileSync(this.sshConfigFilePath, config, {
          encoding: 'utf8',
        });
      }
    } catch (error) {
      this.logger.error('写入ssh配置文件失败', error);
    }
  }

  private removeSshConfig(config: string) {
    try {
      const data = fs
        .readFileSync(this.sshConfigFilePath, { encoding: 'utf8' })
        .replace(config, '')
        .replace(/\n\n+/, '\n\n');
      fs.writeFileSync(this.sshConfigFilePath, data, {
        encoding: 'utf8',
      });
    } catch (error) {
      this.logger.error(`删除ssh配置文件${config}失败`, error);
    }
  }

  public addSSHKey(key: string, alias: string, host: string): void {
    this.generatePrivateKeyFile(alias, key);
    const config = this.generateSingleSshConfig(alias, host);
    this.removeSshConfig(config);
    this.generateSshConfig([config]);
  }

  public removeSSHKey(alias: string, host: string): void {
    this.removePrivateKeyFile(alias);
    const config = this.generateSingleSshConfig(alias, host);
    this.removeSshConfig(config);
  }
}
