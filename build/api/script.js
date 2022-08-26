"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("../config/util");
const express_1 = require("express");
const typedi_1 = require("typedi");
const config_1 = __importDefault(require("../config"));
const fs = __importStar(require("fs"));
const celebrate_1 = require("celebrate");
const path_1 = __importStar(require("path"));
const script_1 = __importDefault(require("../services/script"));
const multer_1 = __importDefault(require("multer"));
const route = (0, express_1.Router)();
const storage = multer_1.default.diskStorage({
    destination: function (req, file, cb) {
        cb(null, config_1.default.scriptPath);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    },
});
const upload = (0, multer_1.default)({ storage: storage });
exports.default = (app) => {
    app.use('/scripts', route);
    route.get('/', async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let result = [];
            const blacklist = ['node_modules', '.git'];
            if (req.query.path) {
                const targetPath = path_1.default.join(config_1.default.scriptPath, req.query.path);
                result = (0, util_1.readDir)(targetPath, config_1.default.scriptPath, blacklist);
            }
            else {
                result = (0, util_1.readDirs)(config_1.default.scriptPath, config_1.default.scriptPath, blacklist);
            }
            res.send({
                code: 200,
                data: result,
            });
        }
        catch (e) {
            logger.error('🔥 error: %o', e);
            return next(e);
        }
    });
    route.get('/:file', async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const filePath = (0, path_1.join)(config_1.default.scriptPath, req.query.path, req.params.file);
            const content = (0, util_1.getFileContentByName)(filePath);
            res.send({ code: 200, data: content });
        }
        catch (e) {
            return next(e);
        }
    });
    route.post('/', upload.single('file'), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let { filename, path, content, originFilename } = req.body;
            if (!path) {
                path = config_1.default.scriptPath;
            }
            if (!path.endsWith('/')) {
                path += '/';
            }
            if (!path.startsWith('/')) {
                path = `${config_1.default.scriptPath}${path}`;
            }
            if (config_1.default.writePathList.every((x) => !path.startsWith(x))) {
                return res.send({
                    code: 430,
                    message: '文件路径禁止访问',
                });
            }
            if (req.file) {
                fs.renameSync(req.file.path, (0, path_1.join)(path, req.file.filename));
                return res.send({ code: 200 });
            }
            if (!originFilename) {
                originFilename = filename;
            }
            const originFilePath = `${path}${originFilename.replace(/\//g, '')}`;
            const filePath = `${path}${filename.replace(/\//g, '')}`;
            if (fs.existsSync(originFilePath)) {
                fs.copyFileSync(originFilePath, `${config_1.default.bakPath}${originFilename.replace(/\//g, '')}`);
                if (filename !== originFilename) {
                    fs.unlinkSync(originFilePath);
                }
            }
            fs.writeFileSync(filePath, content);
            return res.send({ code: 200 });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            filename: celebrate_1.Joi.string().required(),
            path: celebrate_1.Joi.string().optional().allow(''),
            content: celebrate_1.Joi.string().required().allow(''),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let { filename, content, path } = req.body;
            const filePath = (0, path_1.join)(config_1.default.scriptPath, path, filename);
            fs.writeFileSync(filePath, content);
            return res.send({ code: 200 });
        }
        catch (e) {
            return next(e);
        }
    });
    route.delete('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            filename: celebrate_1.Joi.string().required(),
            path: celebrate_1.Joi.string().allow(''),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let { filename, path } = req.body;
            const filePath = (0, path_1.join)(config_1.default.scriptPath, path, filename);
            fs.unlinkSync(filePath);
            res.send({ code: 200 });
        }
        catch (e) {
            return next(e);
        }
    });
    route.post('/download', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            filename: celebrate_1.Joi.string().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let { filename } = req.body;
            const filePath = `${config_1.default.scriptPath}${filename}`;
            // const stats = fs.statSync(filePath);
            // res.set({
            //   'Content-Type': 'application/octet-stream', //告诉浏览器这是一个二进制文件
            //   'Content-Disposition': 'attachment; filename=' + filename, //告诉浏览器这是一个需要下载的文件
            //   'Content-Length': stats.size  //文件大小
            // });
            // fs.createReadStream(filePath).pipe(res);
            return res.download(filePath, filename, (err) => {
                return next(err);
            });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/run', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            filename: celebrate_1.Joi.string().required(),
            content: celebrate_1.Joi.string().optional().allow(''),
            path: celebrate_1.Joi.string().optional().allow(''),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let { filename, content, path } = req.body;
            const { name, ext } = (0, path_1.parse)(filename);
            const filePath = (0, path_1.join)(config_1.default.scriptPath, path, `${name}.swap${ext}`);
            fs.writeFileSync(filePath, content || '', { encoding: 'utf8' });
            const scriptService = typedi_1.Container.get(script_1.default);
            const result = await scriptService.runScript(filePath);
            res.send(result);
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/stop', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            filename: celebrate_1.Joi.string().required(),
            content: celebrate_1.Joi.string().optional().allow(''),
            path: celebrate_1.Joi.string().optional().allow(''),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            let { filename, content, path } = req.body;
            const { name, ext } = (0, path_1.parse)(filename);
            const filePath = (0, path_1.join)(config_1.default.scriptPath, path, `${name}.swap${ext}`);
            const scriptService = typedi_1.Container.get(script_1.default);
            const result = await scriptService.stopScript(filePath);
            res.send(result);
        }
        catch (e) {
            return next(e);
        }
    });
};
//# sourceMappingURL=script.js.map