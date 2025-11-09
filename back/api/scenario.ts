import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import ScenarioService from '../services/scenario';
import { celebrate, Joi } from 'celebrate';

const route = Router();

export default (app: Router) => {
  app.use('/scenarios', route);

  // List all scenarios
  route.get(
    '/',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const data = await scenarioService.list(req.query.searchValue as string);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Create a new scenario
  route.post(
    '/',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        description: Joi.string().optional().allow(''),
        workflowGraph: Joi.object().optional(),
        triggerType: Joi.string()
          .valid('variable', 'webhook', 'task_status', 'time', 'system_event')
          .optional(),
        triggerConfig: Joi.object().optional(),
        conditionLogic: Joi.string().valid('AND', 'OR').default('AND'),
        conditions: Joi.array().optional().default([]),
        actions: Joi.array().optional(),
        retryStrategy: Joi.object({
          maxRetries: Joi.number().min(0).max(10),
          retryDelay: Joi.number().min(1),
          backoffMultiplier: Joi.number().min(1).optional(),
          errorTypes: Joi.array().items(Joi.string()).optional(),
        }).optional(),
        failureThreshold: Joi.number().min(1).default(3),
        delayExecution: Joi.number().min(0).default(0),
        isEnabled: Joi.number().valid(0, 1).default(1),
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

  // Update a scenario
  route.put(
    '/',
    celebrate({
      body: Joi.object({
        id: Joi.number().required(),
        name: Joi.string().optional(),
        description: Joi.string().optional().allow(''),
        workflowGraph: Joi.object().optional(),
        triggerType: Joi.string()
          .valid('variable', 'webhook', 'task_status', 'time', 'system_event')
          .optional(),
        triggerConfig: Joi.object().optional(),
        conditionLogic: Joi.string().valid('AND', 'OR').optional(),
        conditions: Joi.array().optional(),
        actions: Joi.array().optional(),
        retryStrategy: Joi.object({
          maxRetries: Joi.number().min(0).max(10),
          retryDelay: Joi.number().min(1),
          backoffMultiplier: Joi.number().min(1).optional(),
          errorTypes: Joi.array().items(Joi.string()).optional(),
        }).optional(),
        failureThreshold: Joi.number().min(1).optional(),
        delayExecution: Joi.number().min(0).optional(),
        isEnabled: Joi.number().valid(0, 1).optional(),
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

  // Delete scenarios
  route.delete(
    '/',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const data = await scenarioService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Get scenario logs
  route.get(
    '/logs',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const scenarioId = req.query.scenarioId
          ? parseInt(req.query.scenarioId as string)
          : undefined;
        const limit = req.query.limit
          ? parseInt(req.query.limit as string)
          : 100;
        const data = await scenarioService.getLogs(scenarioId, limit);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Manually trigger a scenario
  route.post(
    '/:id/trigger',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
      body: Joi.object().optional().default({}),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        await scenarioService.triggerScenario(
          parseInt(req.params.id),
          req.body,
        );
        return res.send({ code: 200, message: 'Scenario triggered successfully' });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Webhook endpoint for external triggers
  route.post(
    '/webhook/:token',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const scenario = await scenarioService.findByWebhookToken(
          req.params.token,
        );
        
        if (!scenario) {
          return res.status(404).send({ code: 404, message: 'Invalid webhook token' });
        }

        await scenarioService.triggerScenario(scenario.id!, {
          ...req.body,
          headers: req.headers,
          query: req.query,
          webhookTriggered: true,
        });

        return res.send({ code: 200, message: 'Webhook received and scenario triggered' });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Get webhook URL for a scenario
  route.get(
    '/:id/webhook',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scenarioService = Container.get(ScenarioService);
        const token = scenarioService.getWebhookToken(parseInt(req.params.id));
        
        if (!token) {
          return res.status(404).send({ 
            code: 404, 
            message: 'Webhook token not found. Ensure the scenario trigger type is webhook.' 
          });
        }

        const webhookUrl = `${req.protocol}://${req.get('host')}/api/scenarios/webhook/${token}`;
        return res.send({ code: 200, data: { token, webhookUrl } });
      } catch (e) {
        return next(e);
      }
    },
  );
};
