import { Service, Inject } from 'typedi';
import winston from 'winston';
import fs, { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { Subscription } from '../data/subscription';
import { formatUrl } from '../config/subscription';
import config from '../config';

@Service()
export default class SshKeyService {
  private homedir = os.homedir();
  private sshPath = config.sshdPath;
  private sshConfigFilePath = path.resolve(this.homedir, '.ssh', 'config');
  private sshConfigHeader = `Include ${path.join(this.sshPath, '*.config')}`;

  constructor(@Inject('logger') private logger: winston.Logger) {
    this.initSshConfigFile();
  }

  private initSshConfigFile() {
    let config = '';
    if (existsSync(this.sshConfigFilePath)) {
      config = fs.readFileSync(this.sshConfigFilePath, { encoding: 'utf-8' });
    } else {
      fs.writeFileSync(this.sshConfigFilePath, '');
    }
    if (!config.includes(this.sshConfigHeader)) {
      fs.writeFileSync(
        this.sshConfigFilePath,
        `${this.sshConfigHeader}\n\n${config}`,
        { encoding: 'utf-8' },
      );
    }
  }

  private generatePrivateKeyFile(alias: string, key: string): void {
    try {
      fs.writeFileSync(path.join(this.sshPath, alias), `${key}${os.EOL}`, {
        encoding: 'utf8',
        mode: '400',
      });
    } catch (error) {
      this.logger.error('生成私钥文件失败', error);
    }
  }

  private removePrivateKeyFile(alias: string): void {
    try {
      const filePath = path.join(this.sshPath, alias);
      if (existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      this.logger.error('删除私钥文件失败', error);
    }
  }

  private generateSingleSshConfig(alias: string, host: string, proxy?: string) {
    if (host === 'github.com') {
      host = `ssh.github.com\n    Port 443\n    HostkeyAlgorithms +ssh-rsa`;
    }
    const proxyStr = proxy
      ? `    ProxyCommand nc -v -x ${proxy} %h %p 2>/dev/null\n`
      : '';
    const config = `Host ${alias}\n    Hostname ${host}\n    IdentityFile ${path.join(
      this.sshPath,
      alias,
    )}\n    StrictHostKeyChecking no\n${proxyStr}`;
    fs.writeFileSync(`${path.join(this.sshPath, `${alias}.config`)}`, config, {
      encoding: 'utf8',
    });
  }

  private removeSshConfig(alias: string) {
    try {
      const filePath = path.join(this.sshPath, `${alias}.config`);
      if (existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
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
    this.generateSingleSshConfig(alias, host, proxy);
  }

  public removeSSHKey(alias: string, host: string, proxy?: string): void {
    this.removePrivateKeyFile(alias);
    this.removeSshConfig(alias);
  }

  public setSshConfig(docs: Subscription[]) {
    for (const doc of docs) {
      if (doc.type === 'private-repo' && doc.pull_type === 'ssh-key') {
        const { alias, proxy } = doc;
        const { host } = formatUrl(doc);
        this.removePrivateKeyFile(alias);
        this.removeSshConfig(alias);
        this.generatePrivateKeyFile(
          alias,
          (doc.pull_option as any).private_key,
        );
        this.generateSingleSshConfig(alias, host, proxy);
      }
    }
  }
}
