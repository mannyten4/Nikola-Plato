import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.resolve('./logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

type Component = 'browser' | 'slack' | 'ai' | 'orchestrator' | 'health' | 'app' | 'security' | 'reporting';

const isDev = process.env.NODE_ENV !== 'production';

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true })
);

const consoleFormat = winston.format.combine(
  baseFormat,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, component, requestId }) => {
    const comp = component ? `[${component}]` : '';
    const req = requestId ? ` (${requestId})` : '';
    return `${timestamp} ${level} ${comp}${req} ${message}`;
  })
);

const fileFormat = winston.format.combine(
  baseFormat,
  winston.format.json()
);

const rootLogger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'browser-ai-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: fileFormat,
    }),
  ],
});

export function createLogger(component: Component) {
  return {
    info(message: string, requestId?: string) {
      rootLogger.info(message, { component, requestId });
    },
    warn(message: string, requestId?: string) {
      rootLogger.warn(message, { component, requestId });
    },
    error(message: string, error?: unknown, requestId?: string) {
      const errMsg = error instanceof Error ? `${message}: ${error.message}` : message;
      rootLogger.error(errMsg, {
        component,
        requestId,
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
    debug(message: string, requestId?: string) {
      rootLogger.debug(message, { component, requestId });
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
