"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const typedi_1 = require("typedi");
const open_1 = __importDefault(require("../services/open"));
const celebrate_1 = require("celebrate");
const route = (0, express_1.Router)();
exports.default = (app) => {
    app.use('/', route);
    route.get('/apps', async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const openService = typedi_1.Container.get(open_1.default);
            const data = await openService.list();
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.post('/apps', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            name: celebrate_1.Joi.string().optional().allow('').disallow('system'),
            scopes: celebrate_1.Joi.array().items(celebrate_1.Joi.string().required()),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const openService = typedi_1.Container.get(open_1.default);
            const data = await openService.create(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/apps', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.object({
            name: celebrate_1.Joi.string().optional().allow(''),
            scopes: celebrate_1.Joi.array().items(celebrate_1.Joi.string()),
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const openService = typedi_1.Container.get(open_1.default);
            const data = await openService.update(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.delete('/apps', (0, celebrate_1.celebrate)({
        body: celebrate_1.Joi.array().items(celebrate_1.Joi.number().required()),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const openService = typedi_1.Container.get(open_1.default);
            const data = await openService.remove(req.body);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.put('/apps/:id/reset-secret', (0, celebrate_1.celebrate)({
        params: celebrate_1.Joi.object({
            id: celebrate_1.Joi.number().required(),
        }),
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const openService = typedi_1.Container.get(open_1.default);
            const data = await openService.resetSecret(req.params.id);
            return res.send({ code: 200, data });
        }
        catch (e) {
            return next(e);
        }
    });
    route.get('/auth/token', (0, celebrate_1.celebrate)({
        query: {
            client_id: celebrate_1.Joi.string().required(),
            client_secret: celebrate_1.Joi.string().required(),
        },
    }), async (req, res, next) => {
        const logger = typedi_1.Container.get('logger');
        try {
            const openService = typedi_1.Container.get(open_1.default);
            const result = await openService.authToken(req.query);
            return res.send(result);
        }
        catch (e) {
            return next(e);
        }
    });
};
//# sourceMappingURL=open.js.map