"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const typedi_1 = require("typedi");
const subscription_1 = __importDefault(require("../services/subscription"));
const celebrate_1 = require("celebrate");
const cron_parser_1 = __importDefault(require("cron-parser"));
const route = (0, express_1.Router)();
exports.default = (app) => {
    app.use('/subscriptions', route);
    route.get('/', async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.list(req.query.searchValue);
            return res.send({ code: 200, data });
        }
        catch (e) {
            logger.error('🔥 error: %o', e);
            return next(e);
        }
    });
    route.post('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            type: celebrate_1.Joi.string().required(),
            schedule: celebrate_1.Joi.string().optional().allow('').allow(null),
            interval_schedule: celebrate_1.Joi.object({
                type: celebrate_1.Joi.string().required(),
                value: celebrate_1.Joi.number().min(1).required(),
            })
                .optional()
                .allow('')
                .allow(null),
            name: celebrate_1.Joi.string().optional().allow('').allow(null),
            url: celebrate_1.Joi.string().required(),
            whitelist: celebrate_1.Joi.string().optional().allow('').allow(null),
            blacklist: celebrate_1.Joi.string().optional().allow('').allow(null),
            branch: celebrate_1.Joi.string().optional().allow('').allow(null),
            dependences: celebrate_1.Joi.string().optional().allow('').allow(null),
            pull_type: celebrate_1.Joi.string().optional().allow('').allow(null),
            pull_option: celebrate_1.Joi.object().optional().allow('').allow(null),
            extensions: celebrate_1.Joi.string().optional().allow('').allow(null),
            sub_before: celebrate_1.Joi.string().optional().allow('').allow(null),
            sub_after: celebrate_1.Joi.string().optional().allow('').allow(null),
            schedule_type: celebrate_1.Joi.string().required(),
            alias: celebrate_1.Joi.string().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            if (!req.body.schedule ||
                cron_parser_1.default.parseExpression(req.body.schedule).hasNext()) {
                const subscriptionService = typedi_1.Container.get(subscription_1.default);
                const data = await subscriptionService.create(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.run(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.stop(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.disabled(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.enabled(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.log(req.params.id);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            type: celebrate_1.Joi.string().required(),
            schedule: celebrate_1.Joi.string().optional().allow('').allow(null),
            interval_schedule: celebrate_1.Joi.object().optional().allow('').allow(null),
            name: celebrate_1.Joi.string().optional().allow('').allow(null),
            url: celebrate_1.Joi.string().required(),
            whitelist: celebrate_1.Joi.string().optional().allow('').allow(null),
            blacklist: celebrate_1.Joi.string().optional().allow('').allow(null),
            branch: celebrate_1.Joi.string().optional().allow('').allow(null),
            dependences: celebrate_1.Joi.string().optional().allow('').allow(null),
            pull_type: celebrate_1.Joi.string().optional().allow('').allow(null),
            pull_option: celebrate_1.Joi.object().optional().allow('').allow(null),
            schedule_type: celebrate_1.Joi.string().optional().allow('').allow(null),
            extensions: celebrate_1.Joi.string().optional().allow('').allow(null),
            sub_before: celebrate_1.Joi.string().optional().allow('').allow(null),
            sub_after: celebrate_1.Joi.string().optional().allow('').allow(null),
            alias: celebrate_1.Joi.string().required(),
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            if (!req.body.schedule ||
                typeof req.body.schedule === 'object' ||
                cron_parser_1.default.parseExpression(req.body.schedule).hasNext()) {
                const subscriptionService = typedi_1.Container.get(subscription_1.default);
                const data = await subscriptionService.update(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.remove(req.body);
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.getDb({ id: req.params.id });
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
            pid: celebrate_1.Joi.string().optional(),
            log_path: celebrate_1.Joi.string().optional(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.status(Object.assign(Object.assign({}, req.body), { status: parseInt(req.body.status), pid: parseInt(req.body.pid) || '' }));
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
            const subscriptionService = typedi_1.Container.get(subscription_1.default);
            const data = await subscriptionService.logs(req.params.id);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
};
//# sourceMappingURL=subscription.js.map