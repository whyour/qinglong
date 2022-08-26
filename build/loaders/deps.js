"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const chokidar_1 = __importDefault(require("chokidar"));
const index_1 = __importDefault(require("../config/index"));
const util_1 = require("../config/util");
function linkToNodeModule(src, dst) {
    const target = path_1.default.join(index_1.default.rootPath, 'node_modules', dst || src);
    const source = path_1.default.join(index_1.default.rootPath, src);
    fs_1.default.lstat(target, (err, stat) => {
        if (!stat) {
            fs_1.default.symlink(source, target, 'dir', (err) => {
                if (err)
                    throw err;
            });
        }
    });
}
async function linkCommand() {
    const commandPath = await (0, util_1.promiseExec)('which node');
    const commandDir = path_1.default.dirname(commandPath);
    const linkShell = [
        {
            src: 'update.sh',
            dest: 'ql',
        },
        {
            src: 'task.sh',
            dest: 'task',
        },
    ];
    for (const link of linkShell) {
        const source = path_1.default.join(index_1.default.rootPath, 'shell', link.src);
        const target = path_1.default.join(commandDir, link.dest);
        if (fs_1.default.existsSync(target)) {
            fs_1.default.unlinkSync(target);
        }
        fs_1.default.symlink(source, target, (err) => { });
    }
}
exports.default = async (src = 'deps') => {
    await linkCommand();
    linkToNodeModule(src);
    const source = path_1.default.join(index_1.default.rootPath, src);
    const watcher = chokidar_1.default.watch(source, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
    });
    watcher
        .on('add', (path) => linkToNodeModule(src))
        .on('change', (path) => linkToNodeModule(src));
};
//# sourceMappingURL=deps.js.map