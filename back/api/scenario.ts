import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import ScenarioService from '../services/scenario';
import { celebrate, Joi } from 'celebrate';

const route = Router();

export default (app: Router) => {
  app.use('/scenarios', route);

  route.get(
    '/',
    celebrate({
      query: Joi.object({
        searchValue: Joi.string().optional().allow(''),
        page: Joi.number().integer().min(1).default(1),
        size: Joi.number().integer().min(1).max(200).default(50),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const { searchValue, page, size } = req.query as any;
        const result = await scenarioService.list(
          searchValue,
          page ? parseInt(page) : undefined,
          size ? parseInt(size) : undefined,
        );
        return res.send({ code: 200, data: result });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/',
    celebrate({
      body: Joi.object({
        name: Joi.string().trim().max(255).required(),
        description: Joi.string().max(8192).optional().allow(''),
        workflowGraph: Joi.object({
          nodes: Joi.array()
            .max(500)
            .required()
            .items(
              Joi.object({
                id: Joi.string().max(255).required(),
                type: Joi.string().max(100).required(),
              }).unknown(true),
            ),
        })
          .unknown(true)
          .custom((graph, helpers) => {
            return Buffer.byteLength(JSON.stringify(graph)) <= 1024 * 1024
              ? graph
              : helpers.error('any.invalid');
          })
          .optional(),
        status: Joi.number().valid(0, 1).optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const data = await scenarioService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        id: Joi.number().integer().positive().required(),
        name: Joi.string().trim().max(255).required(),
        description: Joi.string().max(8192).optional().allow(''),
        workflowGraph: Joi.object({
          nodes: Joi.array()
            .max(500)
            .required()
            .items(
              Joi.object({
                id: Joi.string().max(255).required(),
                type: Joi.string().max(100).required(),
              }).unknown(true),
            ),
        })
          .unknown(true)
          .custom((graph, helpers) => {
            return Buffer.byteLength(JSON.stringify(graph)) <= 1024 * 1024
              ? graph
              : helpers.error('any.invalid');
          })
          .optional(),
        status: Joi.number().valid(0, 1).optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const data = await scenarioService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.array()
        .min(1)
        .max(200)
        .unique()
        .required()
        .items(Joi.number().integer().positive().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        await scenarioService.remove(req.body);
        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/disable',
    celebrate({
      body: Joi.array()
        .min(1)
        .max(200)
        .unique()
        .required()
        .items(Joi.number().integer().positive().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        await scenarioService.disabled(req.body);
        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/enable',
    celebrate({
      body: Joi.array()
        .min(1)
        .max(200)
        .unique()
        .required()
        .items(Joi.number().integer().positive().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        await scenarioService.enabled(req.body);
        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:id',
    celebrate({
      params: Joi.object({
        id: Joi.number().integer().positive().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const data = await scenarioService.getDb({
          id: parseInt(req.params.id),
        });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );
};
