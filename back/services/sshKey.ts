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
      fs.writeFileSync(`${this.sshPath}/${alias}`, `${key}${os.EOL}`, {
        encoding: 'utf8',
        mode: '400',
      });
    } catch (error) {
      this.logger.error('生成私钥文件失败', error);
    }
  }

  private getConfigRegx(alias: string) {
    return new RegExp(
      `Host ${alias}\n.*[^StrictHostKeyChecking]*.*[\n]*.*StrictHostKeyChecking no`,
      'g',
    );
  }

  private removePrivateKeyFile(alias: string): void {
    try {
      fs.unlinkSync(`${this.sshPath}/${alias}`);
    } catch (error) {
      this.logger.error('删除私钥文件失败', error);
    }
  }

  private generateSingleSshConfig(
    alias: string,
    host: string,
    proxy?: string,
  ): string {
    if (host === 'github.com') {
      host = `ssh.github.com\n    Port 443\n    HostkeyAlgorithms +ssh-rsa\n    PubkeyAcceptedAlgorithms +ssh-rsa`;
    }
    const proxyStr = proxy ? `    ProxyCommand nc -v -x ${proxy} %h %p\n` : '';
    return `\nHost ${alias}\n    Hostname ${host}\n    IdentityFile ${this.sshPath}/${alias}\n    StrictHostKeyChecking no\n${proxyStr}`;
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

  private removeSshConfig(alias: string) {
    try {
      const configRegx = this.getConfigRegx(alias);
      const data = fs
        .readFileSync(this.sshConfigFilePath, { encoding: 'utf8' })
        .replace(configRegx, '')
        .replace(/\n[\n]+/g, '\n');
      fs.writeFileSync(this.sshConfigFilePath, data, {
        encoding: 'utf8',
      });
    } catch (error) {
      this.logger.error(`删除ssh配置文件${alias}失败`, error);
    }
  }

  public addSSHKey(
    key: string,
    alias: string,
    host: string,
    proxy?: string,
  ): void {
    this.generatePrivateKeyFile(alias, key);
    const config = this.generateSingleSshConfig(alias, host, proxy);
    this.removeSshConfig(alias);
    this.generateSshConfig([config]);
  }

  public removeSSHKey(alias: string, host: string, proxy?: string): void {
    this.removePrivateKeyFile(alias);
    const config = this.generateSingleSshConfig(alias, host, proxy);
    this.removeSshConfig(config);
  }
}
