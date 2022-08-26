"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const typedi_1 = require("typedi");
const env_1 = __importDefault(require("../services/env"));
const celebrate_1 = require("celebrate");
const route = (0, express_1.Router)();
exports.default = (app) => {
    app.use('/envs', route);
    route.get('/', async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.envs(req.query.searchValue);
            return res.send({ code: 200, data });
        }
        catch (e) {
            logger.error('🔥 error: %o', e);
            return next(e);
        }
    });
    route.post('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.object({
            value: celebrate_1.Joi.string().required(),
            name: celebrate_1.Joi.string().required(),
            remarks: celebrate_1.Joi.string().optional().allow(''),
        })),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.create(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            value: celebrate_1.Joi.string().required(),
            name: celebrate_1.Joi.string().required(),
            remarks: celebrate_1.Joi.string().optional().allow('').allow(null),
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.update(req.body);
            return res.send({ code: 200, data });
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
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.remove(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/:id/move', (0, celebrate_1.celebrate)({
        params: celebrate_1.Joi.object({
            id: celebrate_1.Joi.number().required(),
        }),
        body: celebrate_1.Joi.object({
            fromIndex: celebrate_1.Joi.number().required(),
            toIndex: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.move(req.params.id, req.body);
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
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.disabled(req.body);
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
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.enabled(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/name', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            ids: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
            name: celebrate_1.Joi.string().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.updateNames(req.body);
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
            const envService = typedi_1.Container.get(env_1.default);
            const data = await envService.getDb({ id: req.params.id });
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
};
//# sourceMappingURL=env.js.map