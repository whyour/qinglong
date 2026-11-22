import type { Crontab } from '../../data/cron';
import { CrontabModel } from '../../data/cron';
import type { Logger } from 'winston';
import config from '../../config/index';
import { execFileSync } from 'child_process';
import cronClient from '../../schedule/client';
import {
  confirmSystemPlan,
  stageSystemPlan,
  suspendSystemPlan,
  SystemRule,
} from './systemScheduleAudit';
import {
  isNodeCron,
  isSpecialSchedule,
  makeCommand,
  schedulerMode,
  SchedulerMode,
} from './cronScheduling';
import { shellQuote } from '../../shared/shellQuote';
import { writeFileWithLock } from '../../shared/utils';
import { asError } from '../../shared/childProcess';
import { t } from '../../shared/i18n';

// Publication is called under the service's scheduler mutation lock. Staging,
// installation and confirmation keep their existing order and failure semantics.
export class SystemCronAdapter {
  constructor(private logger: Logger) {}

  async publish(
    crons: Crontab[],
    mode: () => SchedulerMode = schedulerMode,
    command: (cron: Crontab) => string = makeCommand,
  ) {
    const rules: SystemRule[] = [];
    var crontab_string = '';
    crons.forEach((tab) => {
      if (
        tab.isDisabled === 1 ||
        isNodeCron(tab) ||
        isSpecialSchedule(tab.schedule)
      ) {
        crontab_string += '# ';
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += command(tab);
        crontab_string += '\n';
      } else {
        crontab_string += tab.schedule;
        crontab_string += ' ';
        rules.push({
          id: tab.id!,
          schedule: tab.schedule!,
          name: tab.name || tab.command,
        });
        crontab_string += `QL_SYSTEM_DISPATCHED=$(date +\\%s) QL_SYSTEM_RULE=${shellQuote(
          tab.schedule!,
        )} ID=${
          tab.id
        } QL_TRIGGER_SOURCE=system bash "$QL_DIR/shell/system-cron.sh" ${shellQuote(
          command(tab),
        )}`;
        crontab_string += '\n';
      }
    });

    try {
      const system = mode() === 'system';
      const db = CrontabModel.sequelize!;
      const plan = system ? await stageSystemPlan(db, rules) : undefined;
      if (!system) await suspendSystemPlan(db);
      await writeFileWithLock(config.crontabFile, crontab_string);
      if (plan !== undefined) {
        execFileSync('crontab', [config.crontabFile]);
        await confirmSystemPlan(db, plan);
      }
    } catch (error) {
      this.logger.error(
        '[crontab] Failed to publish crontab:',
        asError(error).message,
      );
      cronClient.readiness.invalidate();
      if (process.env.SERVICE_TYPE === 'grpc')
        process.send?.('crontab-install-failed');
      // A fresh host may have no installed crontab at all. A previous boot's
      // saved flag does not confirm any portable rule in the failed snapshot.
      if (mode() === 'system') {
        const ids = crons
          .filter((row) => !isNodeCron(row) && !isSpecialSchedule(row.schedule))
          .map((row) => row.id!);
        if (ids.length)
          await CrontabModel.update({ saved: false }, { where: { id: ids } });
      }
      throw Object.assign(
        new Error(t('系统定时规则安装失败，旧规则可能仍在运行，正在重试')),
        { status: 503 },
      );
    }
  }
}
