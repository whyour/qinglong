import { Service, Inject } from 'typedi';
import winston from 'winston';
import AuthService from './auth';

@Service()
export default class NotifyService {
  private modeMap = new Map([
    ['goCqHttpBot', this.goCqHttpBot],
    ['serverChan', this.serverChan],
    ['bark', this.bark],
    ['telegramBot', this.telegramBot],
    ['dingtalkBot', this.dingtalkBot],
    ['weWorkBot', this.weWorkBot],
    ['weWorkApp', this.weWorkApp],
    ['iGot', this.iGot],
    ['pushPlus', this.pushPlus],
    ['email', this.email],
  ]);

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private authService: AuthService,
  ) {}

  private async notify() {
    const { type } = await this.authService.getNotificationMode();
    if (type) {
      const notificationModeAction = this.modeMap.get(type);
      notificationModeAction?.call(this);
    }
  }

  private async goCqHttpBot() {}

  private async serverChan() {}

  private async bark() {}

  private async telegramBot() {}

  private async dingtalkBot() {}

  private async weWorkBot() {}

  private async weWorkApp() {}
  private async iGot() {}

  private async pushPlus() {}

  private async email() {}
}
