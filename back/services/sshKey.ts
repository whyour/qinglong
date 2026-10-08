import { Service, Inject } from 'typedi';
import winston from 'winston';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Subscription } from '../data/subscription';
import { formatUrl } from '../config/subscription';
import config from '../config';
import { fileExist, rmPath } from '../config/util';
import { writeFileWithLock } from '../shared/utils';
import {
  getSubscriptionSshAlias,
  resolveSubscriptionPath,
} from '../shared/subscriptionPath';

@Service()
export default class SshKeyService {
  // OpenSSH uses the effective user's passwd entry, not the HOME override.
  private get homedir(): string {
    try {
      return os.userInfo().homedir;
    } catch {
      // Custom container UIDs may have no passwd entry. Keep startup working.
      return os.homedir();
    }
  }
  private sshPath = config.sshdPath;
  private sshConfigFilePath = path.resolve(this.homedir, '.ssh', 'config');
  private sshConfigHeader = `Include ${path.join(this.sshPath, '*.config')}`;

  constructor(@Inject('logger') private logger: winston.Logger) {
    this.initSshConfigFile();
  }

  private async initSshConfigFile() {
    await fs.mkdir(path.dirname(this.sshConfigFilePath), {
      recursive: true,
      mode: 0o700,
    });
    let config = '';
    const _exist = await fileExist(this.sshConfigFilePath);
    if (_exist) {
      config = await fs.readFile(this.sshConfigFilePath, { encoding: 'utf-8' });
    } else {
      await writeFileWithLock(this.sshConfigFilePath, '', { mode: '600' });
    }
    if (!config.includes(this.sshConfigHeader)) {
      await writeFileWithLock(
        this.sshConfigFilePath,
        `${this.sshConfigHeader}\n\n${config}`,
        { mode: '600' },
      );
    }
  }

  private async generatePrivateKeyFile(
    alias: string,
    key: string,
  ): Promise<void> {
    try {
      const filePath = resolveSubscriptionPath(this.sshPath, alias);
      try {
        await rmPath(filePath);
      } catch { }
      await writeFileWithLock(filePath, `${key}${os.EOL}`, { mode: '400' });
    } catch (error) {
      this.logger.error('生成私钥文件失败', error);
    }
  }

  private async removePrivateKeyFile(alias: string): Promise<void> {
    try {
      const filePath = resolveSubscriptionPath(this.sshPath, alias);
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
    if (!/^[a-zA-Z0-9.-]+$/.test(host) ||
        (proxy && !/^[a-zA-Z0-9.:[\]-]+$/.test(proxy))) {
      throw Object.assign(new Error('Invalid SSH host or proxy'), { status: 400 });
    }
    if (host === 'github.com') {
      host = `ssh.github.com\n    Port 443\n    HostkeyAlgorithms +ssh-rsa`;
    }
    const proxyStr = proxy
      ? `    ProxyCommand nc -v -x ${proxy} %h %p 2>/dev/null\n`
      : '';
    const config = `Host ${alias}\n    Hostname ${host}\n    IdentityFile ${resolveSubscriptionPath(this.sshPath, alias)}\n    StrictHostKeyChecking no\n${proxyStr}`;
    await writeFileWithLock(
      `${resolveSubscriptionPath(this.sshPath, alias, '.config')}`,
      config,
      {
        encoding: 'utf8',
        mode: '600',
      },
    );
  }

  private async removeSshConfig(alias: string) {
    try {
      const filePath = resolveSubscriptionPath(this.sshPath, alias, '.config');
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
    alias = getSubscriptionSshAlias(alias);
    await this.generatePrivateKeyFile(alias, key);
    await this.generateSingleSshConfig(alias, host, proxy);
  }

  public async removeSSHKey(
    alias: string,
    host: string,
    proxy?: string,
  ): Promise<void> {
    alias = getSubscriptionSshAlias(alias);
    await this.removePrivateKeyFile(alias);
    await this.removeSshConfig(alias);
  }

  public async setSshConfig(docs: Subscription[]) {
    for (const doc of docs) {
      if (doc.type === 'private-repo' && doc.pull_type === 'ssh-key') {
        try {
          const alias = getSubscriptionSshAlias(doc.alias);
          const { host } = formatUrl(doc);
          await this.removePrivateKeyFile(alias);
          await this.removeSshConfig(alias);
          await this.generatePrivateKeyFile(
            alias,
            (doc.pull_option as any).private_key,
          );
          await this.generateSingleSshConfig(alias, host, doc.proxy);
        } catch (error) {
          this.logger.warn('跳过订阅 %s 的无效 SSH 配置: %s', doc.id, error);
        }
      }
    }
  }

  public async addGlobalSSHKey(key: string, alias: string): Promise<void> {
    await this.generatePrivateKeyFile(`~global_${alias}`, key);
    // Create a global SSH config entry that matches all hosts
    // This allows the key to be used for any Git repository
    await this.generateGlobalSshConfig(`~global_${alias}`);
  }

  public async removeGlobalSSHKey(alias: string): Promise<void> {
    await this.removePrivateKeyFile(`~global_${alias}`);
    await this.removeSshConfig(`~global_${alias}`);
  }

  private async generateGlobalSshConfig(alias: string) {
    // Create a config that matches all hosts, making this key globally available
    const config = `Host *\n    IdentityFile ${resolveSubscriptionPath(this.sshPath, alias)}\n    StrictHostKeyChecking no\n`;
    await writeFileWithLock(
      `${resolveSubscriptionPath(this.sshPath, alias, '.config')}`,
      config,
      {
        encoding: 'utf8',
        mode: '600',
      },
    );
  }
}
