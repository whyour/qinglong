import winston from 'winston';
import 'winston-daily-rotate-file';
import config from '../config';
import path from 'path';

const levelMap: Record<string, string> = {
  info: '\ue6f5',
  warn: '\ue880',
  error: '\ue602',
  debug: '\ue67f'
}

const customFormat = winston.format.combine(
  winston.format.splat(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.align(),
  winston.format.printf((i) => `[${levelMap[i.level]}${i.level}] [${[i.timestamp]}]: ${i.message}`),
);

const defaultOptions = {
  format: customFormat,
  datePattern: "YYYY-MM-DD",
  maxSize: "20m",
  maxFiles: "7d",
};

const LoggerInstance = winston.createLogger({
  level: config.logs.level,
  levels: winston.config.npm.levels,
  transports: [
    new winston.transports.DailyRotateFile({
      filename: path.join(config.systemLogPath, '%DATE%.log'),
      ...defaultOptions,
    })
  ],
});

export default LoggerInstance;
