import { Service, Inject } from 'typedi';
import winston from 'winston';
import { Scenario, ScenarioModel } from '../data/scenario';
import { ScenarioLog, ScenarioLogModel } from '../data/scenarioLog';
import { Op } from 'sequelize';
import CronService from './cron';
import EnvService from './env';
import dayjs from 'dayjs';
import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../config';
import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';
import { GraphExecutor } from './graphExecutor';

const execAsync = promisify(exec);

@Service()
export default class ScenarioService {
  private watchers: Map<number, any> = new Map();
  private webhookTokens: Map<number, string> = new Map();
  private graphExecutor: GraphExecutor;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private cronService: CronService,
    private envService: EnvService,
  ) {
    this.graphExecutor = new GraphExecutor(logger);
    this.initializeWatchers();
  }

  private async initializeWatchers() {
    try {
      const scenarios = await this.list({ isEnabled: 1 });
      for (const scenario of scenarios) {
        if (scenario.triggerType === 'variable') {
          await this.setupVariableWatcher(scenario);
        } else if (scenario.triggerType === 'system_event') {
          await this.setupSystemEventWatcher(scenario);
        }
      }
    } catch (error) {
      this.logger.error('Failed to initialize scenario watchers:', error);
    }
  }

  public async create(payload: Scenario): Promise<Scenario> {
    const scenario = await ScenarioModel.create(payload, { returning: true });
    
    if (scenario.isEnabled === 1) {
      await this.enableScenarioTrigger(scenario);
    }

    return scenario;
  }

  public async update(payload: Partial<Scenario>): Promise<Scenario> {
    const oldScenario = await this.getDb({ id: payload.id });
    await ScenarioModel.update(payload, { where: { id: payload.id } });
    const newScenario = await this.getDb({ id: payload.id });

    // Handle trigger changes
    if (oldScenario.isEnabled === 1) {
      await this.disableScenarioTrigger(oldScenario);
    }

    if (newScenario.isEnabled === 1) {
      await this.enableScenarioTrigger(newScenario);
    }

    return newScenario;
  }

  public async remove(ids: number[]): Promise<number> {
    for (const id of ids) {
      const scenario = await this.getDb({ id });
      if (scenario) {
        await this.disableScenarioTrigger(scenario);
      }
    }
    return await ScenarioModel.destroy({ where: { id: ids } });
  }

  public async list(
    searchText?: string | { isEnabled: number },
  ): Promise<Scenario[]> {
    let where: any = {};
    
    if (typeof searchText === 'string') {
      where = {
        [Op.or]: [
          { name: { [Op.like]: `%${searchText}%` } },
          { description: { [Op.like]: `%${searchText}%` } },
        ],
      };
    } else if (typeof searchText === 'object') {
      where = searchText;
    }

    const result = await ScenarioModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });
    return result;
  }

  public async getDb(query: any): Promise<Scenario> {
    const doc: any = await ScenarioModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as Scenario);
  }

  private async enableScenarioTrigger(scenario: Scenario) {
    switch (scenario.triggerType) {
      case 'variable':
        await this.setupVariableWatcher(scenario);
        break;
      case 'webhook':
        this.setupWebhookTrigger(scenario);
        break;
      case 'time':
        await this.setupTimeTrigger(scenario);
        break;
      case 'system_event':
        await this.setupSystemEventWatcher(scenario);
        break;
      case 'task_status':
        // Task status triggers are handled in the cron execution flow
        break;
    }
  }

  private async disableScenarioTrigger(scenario: Scenario) {
    if (scenario.triggerType === 'variable' || scenario.triggerType === 'system_event') {
      const watcher = this.watchers.get(scenario.id!);
      if (watcher) {
        await watcher.close();
        this.watchers.delete(scenario.id!);
      }
    } else if (scenario.triggerType === 'webhook') {
      this.webhookTokens.delete(scenario.id!);
    } else if (scenario.triggerType === 'time') {
      // Remove time trigger (would need to cancel scheduled task)
    }
  }

  private async setupVariableWatcher(scenario: Scenario) {
    if (!scenario.triggerConfig || !scenario.triggerConfig.watchPath) {
      return;
    }

    const watchPath = scenario.triggerConfig.watchPath;
    const watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: true,
    }) as any;

    watcher.on('change', async (filePath: string) => {
      this.logger.info(
        `Variable change detected for scenario ${scenario.name}: ${filePath}`,
      );
      await this.triggerScenario(scenario.id!, { filePath, type: 'change' });
    });

    this.watchers.set(scenario.id!, watcher);
  }

  private setupWebhookTrigger(scenario: Scenario) {
    // Generate a unique token for this webhook
    const token = scenario.triggerConfig?.token || this.generateWebhookToken();
    this.webhookTokens.set(scenario.id!, token);
  }

  private async setupTimeTrigger(scenario: Scenario) {
    // This would integrate with the existing cron system
    // For now, we'll create a cron job that triggers the scenario
    if (scenario.triggerConfig && scenario.triggerConfig.schedule) {
      // Would create a cron entry that calls triggerScenario
    }
  }

  private async setupSystemEventWatcher(scenario: Scenario) {
    const eventType = scenario.triggerConfig?.eventType;
    
    if (eventType === 'disk_space' || eventType === 'memory') {
      // Set up periodic checks
      const interval = scenario.triggerConfig?.checkInterval || 60000; // Default 1 minute
      
      const checkSystem = async () => {
        const metrics = await this.getSystemMetrics();
        const threshold = scenario.triggerConfig?.threshold;
        
        let shouldTrigger = false;
        if (eventType === 'disk_space' && metrics.diskUsagePercent > threshold) {
          shouldTrigger = true;
        } else if (eventType === 'memory' && metrics.memoryUsagePercent > threshold) {
          shouldTrigger = true;
        }
        
        if (shouldTrigger) {
          await this.triggerScenario(scenario.id!, metrics);
        }
      };
      
      const timer = setInterval(checkSystem, interval);
      this.watchers.set(scenario.id!, { close: () => clearInterval(timer) });
    }
  }

  private async getSystemMetrics() {
    try {
      // Get disk usage
      const { stdout: diskOutput } = await execAsync("df -h / | tail -1 | awk '{print $5}' | sed 's/%//'");
      const diskUsagePercent = parseInt(diskOutput.trim());
      
      // Get memory usage
      const { stdout: memOutput } = await execAsync("free | grep Mem | awk '{print ($3/$2) * 100.0}'");
      const memoryUsagePercent = parseFloat(memOutput.trim());
      
      return { diskUsagePercent, memoryUsagePercent };
    } catch (error) {
      this.logger.error('Failed to get system metrics:', error);
      return { diskUsagePercent: 0, memoryUsagePercent: 0 };
    }
  }

  private generateWebhookToken(): string {
    return Math.random().toString(36).substring(2, 15) +
           Math.random().toString(36).substring(2, 15);
  }

  public async triggerScenario(
    scenarioId: number,
    triggerData: any,
  ): Promise<void> {
    const scenario = await this.getDb({ id: scenarioId });
    
    if (!scenario || scenario.isEnabled !== 1) {
      return;
    }

    // Update last triggered time
    await ScenarioModel.update(
      { lastTriggeredAt: new Date() },
      { where: { id: scenarioId } },
    );

    // Check if circuit breaker is triggered
    if (
      scenario.consecutiveFailures &&
      scenario.failureThreshold &&
      scenario.consecutiveFailures >= scenario.failureThreshold
    ) {
      this.logger.warn(
        `Scenario ${scenario.name} is disabled due to consecutive failures`,
      );
      await ScenarioModel.update(
        { isEnabled: 0 },
        { where: { id: scenarioId } },
      );
      return;
    }

    // Apply delay if configured
    if (scenario.delayExecution && scenario.delayExecution > 0) {
      setTimeout(
        () => this.executeScenario(scenario, triggerData),
        scenario.delayExecution * 1000,
      );
    } else {
      await this.executeScenario(scenario, triggerData);
    }
  }

  private async executeScenario(
    scenario: Scenario,
    triggerData: any,
    retryCount: number = 0,
  ): Promise<void> {
    const startTime = Date.now();
    const log: Partial<ScenarioLog> = {
      scenarioId: scenario.id!,
      scenarioName: scenario.name,
      triggerData,
      retriesAttempted: retryCount,
    };

    try {
      // Check if this is a graph-based workflow
      if (scenario.workflowGraph && scenario.workflowGraph.nodes && scenario.workflowGraph.nodes.length > 0) {
        // Execute using graph executor
        const result = await this.graphExecutor.executeGraph(
          scenario.workflowGraph,
          triggerData,
          this,
        );

        log.conditionsMatched = true; // Graph execution handles conditions internally
        log.executionStatus = result.success ? 'success' : 'failure';
        log.executionDetails = result.results;
        log.executionTime = Date.now() - startTime;

        if (!result.success) {
          throw new Error(JSON.stringify(result.results));
        }
      } else {
        // Legacy execution path for form-based scenarios
        // Evaluate conditions
        const conditionsMatched = await this.evaluateConditions(
          scenario.conditions || [],
          scenario.conditionLogic || 'AND',
          triggerData,
        );
        
        log.conditionsMatched = conditionsMatched;

        if (!conditionsMatched) {
          log.executionStatus = 'success';
          log.executionDetails = { message: 'Conditions not matched, skipped' };
          await this.createLog(log);
          return;
        }

        // Execute actions
        const actionResults = await this.executeActions(scenario.actions || []);
        
        log.executionStatus = 'success';
        log.executionDetails = actionResults;
        log.executionTime = Date.now() - startTime;
      }

      // Update scenario stats
      await ScenarioModel.update(
        {
          lastExecutedAt: new Date(),
          executionCount: (scenario.executionCount || 0) + 1,
          successCount: (scenario.successCount || 0) + 1,
          consecutiveFailures: 0,
        },
        { where: { id: scenario.id } },
      );

      await this.createLog(log);
    } catch (error: any) {
      log.executionStatus = 'failure';
      log.errorMessage = error.message;
      log.executionTime = Date.now() - startTime;

      this.logger.error(`Scenario ${scenario.name} execution failed:`, error);

      // Handle retry logic
      const shouldRetry = scenario.retryStrategy &&
        retryCount < (scenario.retryStrategy.maxRetries || 0);

      if (shouldRetry) {
        const delay = this.calculateRetryDelay(scenario.retryStrategy!, retryCount);
        setTimeout(
          () => this.executeScenario(scenario, triggerData, retryCount + 1),
          delay,
        );
        return;
      }

      // Update failure stats
      await ScenarioModel.update(
        {
          lastExecutedAt: new Date(),
          executionCount: (scenario.executionCount || 0) + 1,
          failureCount: (scenario.failureCount || 0) + 1,
          consecutiveFailures: (scenario.consecutiveFailures || 0) + 1,
        },
        { where: { id: scenario.id } },
      );

      await this.createLog(log);
    }
  }

  private async evaluateConditions(
    conditions: any[],
    logic: 'AND' | 'OR',
    triggerData: any,
  ): Promise<boolean> {
    if (conditions.length === 0) {
      return true; // No conditions means always execute
    }

    const results = await Promise.all(
      conditions.map((condition) => this.evaluateCondition(condition, triggerData)),
    );

    if (logic === 'AND') {
      return results.every((r) => r);
    } else {
      return results.some((r) => r);
    }
  }

  private async evaluateCondition(
    condition: any,
    triggerData: any,
  ): Promise<boolean> {
    // Simple condition evaluation
    // condition format: { field: string, operator: string, value: any }
    const { field, operator, value } = condition;
    const actualValue = this.getFieldValue(triggerData, field);

    switch (operator) {
      case 'equals':
        return actualValue === value;
      case 'not_equals':
        return actualValue !== value;
      case 'greater_than':
        return actualValue > value;
      case 'less_than':
        return actualValue < value;
      case 'contains':
        return String(actualValue).includes(String(value));
      case 'not_contains':
        return !String(actualValue).includes(String(value));
      default:
        return false;
    }
  }

  private getFieldValue(data: any, field: string): any {
    const parts = field.split('.');
    let value = data;
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = value[part];
      } else {
        return undefined;
      }
    }
    return value;
  }

  private async executeActions(actions: any[]): Promise<any[]> {
    const results = [];
    
    for (const action of actions) {
      try {
        const result = await this.executeAction(action);
        results.push({ action: action.type, success: true, result });
      } catch (error: any) {
        results.push({ action: action.type, success: false, error: error.message });
      }
    }
    
    return results;
  }

  private async executeAction(action: any): Promise<any> {
    switch (action.type) {
      case 'run_task':
        // Execute a cron task
        if (action.cronId) {
          return await this.cronService.run([action.cronId]);
        }
        break;
      case 'set_variable':
        // Set an environment variable
        if (action.name && action.value !== undefined) {
          return await this.envService.create([{
            name: action.name,
            value: action.value,
            remarks: `Set by scenario: ${action.scenarioName || 'unknown'}`,
          }]);
        }
        break;
      case 'send_notification':
        // Would integrate with notification service
        this.logger.info(`Notification: ${action.message}`);
        break;
      case 'execute_command':
        // Execute a shell command
        if (action.command) {
          const { stdout, stderr } = await execAsync(action.command);
          return { stdout, stderr };
        }
        break;
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  private calculateRetryDelay(
    retryStrategy: any,
    retryCount: number,
  ): number {
    const baseDelay = retryStrategy.retryDelay || 5;
    const multiplier = retryStrategy.backoffMultiplier || 1;
    return baseDelay * 1000 * Math.pow(multiplier, retryCount);
  }

  private async createLog(log: Partial<ScenarioLog>): Promise<void> {
    await ScenarioLogModel.create(log as any);
  }

  public async getLogs(scenarioId?: number, limit: number = 100): Promise<ScenarioLog[]> {
    const where = scenarioId ? { scenarioId } : {};
    const logs = await ScenarioLogModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    });
    return logs;
  }

  public getWebhookToken(scenarioId: number): string | undefined {
    return this.webhookTokens.get(scenarioId);
  }

  public async findByWebhookToken(token: string): Promise<Scenario | null> {
    for (const [scenarioId, webhookToken] of this.webhookTokens.entries()) {
      if (webhookToken === token) {
        return await this.getDb({ id: scenarioId });
      }
    }
    return null;
  }

  // Public methods for graph executor
  public async executeRunTask(data: any): Promise<any> {
    if (data.cronId) {
      return await this.cronService.run([data.cronId]);
    }
    throw new Error('cronId is required for run_task action');
  }

  public async executeSetVariable(data: any): Promise<any> {
    if (data.name && data.value !== undefined) {
      return await this.envService.create([{
        name: data.name,
        value: data.value,
        remarks: `Set by scenario workflow`,
      }]);
    }
    throw new Error('name and value are required for set_variable action');
  }

  public async executeCommand(data: any): Promise<any> {
    if (data.command) {
      const { stdout, stderr } = await execAsync(data.command);
      return { stdout, stderr };
    }
    throw new Error('command is required for execute_command action');
  }

  public async executeSendNotification(data: any): Promise<any> {
    // Log notification for now - can be extended to integrate with notification service
    this.logger.info(`Notification: ${data.message || 'No message'}`);
    return { sent: true, message: data.message };
  }
}
