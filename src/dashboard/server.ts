import express from 'express';
import path from 'path';
import { config } from '../config';
import { RequestTracker } from '../state/request-tracker';
import { HealthMonitor } from '../monitoring/health';
import { createApiRoutes } from './routes';
import { createLogger } from '../utils/logger';

const logger = createLogger('app');

let server: ReturnType<typeof express.prototype.listen> | null = null;

export function startDashboard(tracker: RequestTracker, healthMonitor: HealthMonitor): void {
  const app = express();
  const port = config.dashboard.port;

  // Basic auth middleware
  app.use((req, res, next) => {
    // Skip auth for health check endpoint
    if (req.path === '/api/health' && req.query.key === 'ping') {
      next();
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Nikola Control Center"');
      res.status(401).send('Authentication required');
      return;
    }

    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const [username, password] = decoded.split(':');

    if (username === config.dashboard.username && password === config.dashboard.password) {
      next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="Nikola Control Center"');
      res.status(401).send('Invalid credentials');
    }
  });

  // Serve static files — resolve from project root to handle both ts-node and compiled dist/
  const publicDir = path.resolve(__dirname, '..', '..', 'src', 'dashboard', 'public');
  const publicDirFallback = path.join(__dirname, 'public');
  const staticDir = require('fs').existsSync(publicDir) ? publicDir : publicDirFallback;
  app.use(express.static(staticDir));

  // API routes
  app.use('/api', createApiRoutes(tracker, healthMonitor));

  // SPA fallback
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  server = app.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
