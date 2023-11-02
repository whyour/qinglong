import { Service, Inject } from 'typedi';
import winston from 'winston';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Subscription } from '../data/subscription';
import { formatUrl } from '../config/subscription';
import config from '../config';
import { fileExist, rmPath } from '../config/util';

@Service()
export default class SshKeyService {
  private homedir = os.homedir();
  private sshPath = config.sshdPath;
  private sshConfigFilePath = path.resolve(this.homedir, '.ssh', 'config');
  private sshConfigHeader = `Include ${path.join(this.sshPath, '*.config')}`;

  constructor(@Inject('logger') private logger: winston.Logger) {
    this.initSshConfigFile();
  }

  private async initSshConfigFile() {
    let config = '';
    const _exist = await fileExist(this.sshConfigFilePath);
    if (_exist) {
      config = await fs.readFile(this.sshConfigFilePath, { encoding: 'utf-8' });
    } else {
      await fs.writeFile(this.sshConfigFilePath, '');
    }
    if (!config.includes(this.sshConfigHeader)) {
      await fs.writeFile(
        this.sshConfigFilePath,
        `${this.sshConfigHeader}\n\n${config}`,
        { encoding: 'utf-8' },
      );
    }
  }

  private async generatePrivateKeyFile(
    alias: string,
    key: string,
  ): Promise<void> {
    try {
      await fs.writeFile(path.join(this.sshPath, alias), `${key}${os.EOL}`, {
        encoding: 'utf8',
        mode: '400',
      });
    } catch (error) {
      this.logger.error('生成私钥文件失败', error);
    }
  }

  private async removePrivateKeyFile(alias: string): Promise<void> {
    try {
      const filePath = path.join(this.sshPath, alias);
      await rmPath(filePath);
    } catch (error) {
      this.logger.error('删除私钥文件失败', error);
    }
  }

  private async generateSingleSshConfig(
    alias: string,
    host: string,
    proxy?: string,
  ) {
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
    await fs.writeFile(
      `${path.join(this.sshPath, `${alias}.config`)}`,
      config,
      {
        encoding: 'utf8',
      },
    );
  }

  private async removeSshConfig(alias: string) {
    try {
      const filePath = path.join(this.sshPath, `${alias}.config`);
      await rmPath(filePath);
    } catch (error) {
      this.logger.error(`删除ssh配置文件${alias}失败`, error);
    }
  }

  public async addSSHKey(
    key: string,
    alias: string,
    host: string,
    proxy?: string,
  ): Promise<void> {
    await this.generatePrivateKeyFile(alias, key);
    await this.generateSingleSshConfig(alias, host, proxy);
  }

  public async removeSSHKey(alias: string, host: string, proxy?: string): Promise<void> {
    await this.removePrivateKeyFile(alias);
    await this.removeSshConfig(alias);
  }

  public async setSshConfig(docs: Subscription[]) {
    for (const doc of docs) {
      if (doc.type === 'private-repo' && doc.pull_type === 'ssh-key') {
        const { alias, proxy } = doc;
        const { host } = formatUrl(doc);
        await this.removePrivateKeyFile(alias);
        await this.removeSshConfig(alias);
        await this.generatePrivateKeyFile(
          alias,
          (doc.pull_option as any).private_key,
        );
        await this.generateSingleSshConfig(alias, host, proxy);
      }
    }
  }
}
