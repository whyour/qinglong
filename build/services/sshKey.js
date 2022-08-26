"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const typedi_1 = require("typedi");
const winston_1 = __importDefault(require("winston"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
let SshKeyService = class SshKeyService {
    constructor(logger) {
        this.logger = logger;
        this.homedir = os_1.default.homedir();
        this.sshPath = path_1.default.resolve(this.homedir, '.ssh');
        this.sshConfigFilePath = path_1.default.resolve(this.sshPath, 'config');
    }
    generatePrivateKeyFile(alias, key) {
        try {
            fs_1.default.writeFileSync(`${this.sshPath}/${alias}`, key, {
                encoding: 'utf8',
                mode: '400',
            });
        }
        catch (error) {
            this.logger.error('生成私钥文件失败', error);
        }
    }
    getConfigRegx(alias) {
        return new RegExp(`Host ${alias}\n.*[^StrictHostKeyChecking]*.*[\n]*.*StrictHostKeyChecking no`, 'g');
    }
    removePrivateKeyFile(alias) {
        try {
            fs_1.default.unlinkSync(`${this.sshPath}/${alias}`);
        }
        catch (error) {
            this.logger.error('删除私钥文件失败', error);
        }
    }
    generateSingleSshConfig(alias, host) {
        return `\nHost ${alias}\n    Hostname ${host}\n    IdentityFile ${this.sshPath}/${alias}\n    StrictHostKeyChecking no`;
    }
    generateSshConfig(configs) {
        try {
            for (const config of configs) {
                fs_1.default.appendFileSync(this.sshConfigFilePath, config, {
                    encoding: 'utf8',
                });
            }
        }
        catch (error) {
            this.logger.error('写入ssh配置文件失败', error);
        }
    }
    removeSshConfig(alias) {
        try {
            const configRegx = this.getConfigRegx(alias);
            const data = fs_1.default
                .readFileSync(this.sshConfigFilePath, { encoding: 'utf8' })
                .replace(configRegx, '')
                .replace(/\n[\n]+/g, '\n');
            fs_1.default.writeFileSync(this.sshConfigFilePath, data, {
                encoding: 'utf8',
            });
        }
        catch (error) {
            this.logger.error(`删除ssh配置文件${alias}失败`, error);
        }
    }
    addSSHKey(key, alias, host) {
        this.generatePrivateKeyFile(alias, key);
        const config = this.generateSingleSshConfig(alias, host);
        this.removeSshConfig(alias);
        this.generateSshConfig([config]);
    }
    removeSSHKey(alias, host) {
        this.removePrivateKeyFile(alias);
        const config = this.generateSingleSshConfig(alias, host);
        this.removeSshConfig(config);
    }
};
SshKeyService = __decorate([
    (0, typedi_1.Service)(),
    __param(0, (0, typedi_1.Inject)('logger')),
    __metadata("design:paramtypes", [winston_1.default.Logger])
], SshKeyService);
exports.default = SshKeyService;
//# sourceMappingURL=sshKey.js.map