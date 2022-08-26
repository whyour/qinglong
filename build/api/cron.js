"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const typedi_1 = require("typedi");
const cron_1 = __importDefault(require("../services/cron"));
const celebrate_1 = require("celebrate");
const cron_parser_1 = __importDefault(require("cron-parser"));
const route = (0, express_1.Router)();
exports.default = (app) => {
    app.use('/crons', route);
    route.get('/', (0, celebrate_1.celebrate)({
        query: celebrate_1.Joi.object({
            searchText: celebrate_1.Joi.string().required().allow(''),
            page: celebrate_1.Joi.string().required(),
            size: celebrate_1.Joi.string().required(),
            t: celebrate_1.Joi.string().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.crontabs(req.query);
            return res.send({ code: 200, data });
        }
        catch (e) {
            logger.error('🔥 error: %o', e);
            return next(e);
        }
    });
    route.post('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            command: celebrate_1.Joi.string().required(),
            schedule: celebrate_1.Joi.string().required(),
            name: celebrate_1.Joi.string().optional(),
            labels: celebrate_1.Joi.array().optional(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            if (cron_parser_1.default.parseExpression(req.body.schedule).hasNext()) {
                const cronService = typedi_1.Container.get(cron_1.default);
                const data = await cronService.create(req.body);
                return res.send({ code: 200, data });
            }
            else {
                return res.send({ code: 400, message: 'param schedule error' });
            }
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/run', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.run(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/stop', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.stop(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.delete('/labels', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            ids: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
            labels: celebrate_1.Joi.array().items(celebrate_1.Joi.string().required()),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.removeLabels(req.body.ids, req.body.labels);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.post('/labels', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            ids: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
            labels: celebrate_1.Joi.array().items(celebrate_1.Joi.string().required()),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.addLabels(req.body.ids, req.body.labels);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/disable', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.disabled(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/enable', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.enabled(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.get('/:id/log', (0, celebrate_1.celebrate)({
        params: celebrate_1.Joi.object({
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.log(req.params.id);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            labels: celebrate_1.Joi.array().optional().allow(null),
            command: celebrate_1.Joi.string().required(),
            schedule: celebrate_1.Joi.string().required(),
            name: celebrate_1.Joi.string().optional().allow(null),
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            if (!req.body.schedule ||
                cron_parser_1.default.parseExpression(req.body.schedule).hasNext()) {
                const cronService = typedi_1.Container.get(cron_1.default);
                const data = await cronService.update(req.body);
                return res.send({ code: 200, data });
            }
            else {
                return res.send({ code: 400, message: 'param schedule error' });
            }
        }
        catch (e) {
            return next(e);
        }
    });
    route.delete('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.remove(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/pin', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.pin(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/unpin', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.unPin(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.get('/import', async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.import_crontab();
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.get('/:id', (0, celebrate_1.celebrate)({
        params: celebrate_1.Joi.object({
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.getDb({ id: req.params.id });
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/status', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            ids: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
            status: celebrate_1.Joi.string().required(),
            pid: celebrate_1.Joi.string().optional().allow(null),
            log_path: celebrate_1.Joi.string().optional().allow(null),
            last_running_time: celebrate_1.Joi.number().optional().allow(null),
            last_execution_time: celebrate_1.Joi.number().optional().allow(null),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.status(Object.assign(Object.assign({}, req.body), { status: parseInt(req.body.status), pid: parseInt(req.body.pid) || '' }));
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.get('/:id/logs', (0, celebrate_1.celebrate)({
        params: celebrate_1.Joi.object({
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const cronService = typedi_1.Container.get(cron_1.default);
            const data = await cronService.logs(req.params.id);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
};
//# sourceMappingURL=cron.js.map