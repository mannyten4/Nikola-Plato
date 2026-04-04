import { Router, Request, Response } from 'express';
import { RequestTracker } from '../state/request-tracker';
import { HealthMonitor } from '../monitoring/health';

export function createApiRoutes(tracker: RequestTracker, healthMonitor: HealthMonitor): Router {
  const router = Router();

  // GET /api/stats
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const todayStats = tracker.getTodayStats();
      const weekStats = tracker.getRequestStats();
      const monthStats = tracker.getMonthlyStats();
      const allTime = tracker.getAllTimeStats();
      const dailyTotal = tracker.getDailyTotal();
      const health = await healthMonitor.getHealth();

      const successRate = todayStats.total > 0
        ? ((todayStats.completed / todayStats.total) * 100).toFixed(1)
        : '0';

      res.json({
        today: {
          count: todayStats.total,
          completed: todayStats.completed,
          failed: todayStats.failed,
          amount: dailyTotal,
          avgDurationMs: todayStats.avgDurationMs,
          successRate: parseFloat(successRate),
        },
        week: {
          count: weekStats.week_count,
          completed: weekStats.week_completed,
        },
        month: {
          count: monthStats.total,
          completed: monthStats.completed,
          failed: monthStats.failed,
          amount: monthStats.total_amount,
        },
        allTime: {
          count: allTime.total,
          completed: allTime.completed,
          failed: allTime.failed,
          amount: allTime.total_amount,
        },
        system: {
          browserStatus: health.browserStatus,
          slackConnected: health.slackConnected,
          queueDepth: health.queueDepth,
          queueProcessing: health.queueProcessing,
          uptimeMs: health.uptimeMs,
          uptimeFormatted: health.uptimeFormatted,
          lastSuccessfulComCheck: health.lastSuccessfulComCheck,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // GET /api/comchecks
  router.get('/comchecks', (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const status = req.query.status as string | undefined;
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;

      const result = tracker.getAllRequests(page, limit, status, from, to);
      res.json({
        data: result.rows,
        total: result.total,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch comchecks' });
    }
  });

  // GET /api/comchecks/:id
  router.get('/comchecks/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const request = tracker.getRequest(id);
      if (!request) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const auditLog = tracker.getAuditLog(id);
      res.json({ ...request, audit_log: auditLog });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch comcheck' });
    }
  });

  // GET /api/token-usage
  router.get('/token-usage', (_req: Request, res: Response) => {
    try {
      const stats = tracker.getTokenUsageStats();
      const daily = tracker.getTokenUsageDaily(30);
      res.json({ stats, daily });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch token usage' });
    }
  });

  // GET /api/conversations
  router.get('/conversations', (_req: Request, res: Response) => {
    try {
      const conversations = tracker.getConversations(50);
      res.json(conversations);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  });

  // GET /api/security
  router.get('/security', (_req: Request, res: Response) => {
    try {
      const events = tracker.getSecurityEvents(100);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch security events' });
    }
  });

  // GET /api/health
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const health = await healthMonitor.getHealth();
      const todayStats = tracker.getTodayStats();
      res.json({
        ...health,
        memoryUsage: process.memoryUsage(),
        todayStats,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch health' });
    }
  });

  // GET /api/charts/daily
  router.get('/charts/daily', (_req: Request, res: Response) => {
    try {
      const daily = tracker.getComchecksByDay(30);
      res.json(daily);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch chart data' });
    }
  });

  // GET /api/charts/dispatchers
  router.get('/charts/dispatchers', (_req: Request, res: Response) => {
    try {
      const dispatchers = tracker.getComchecksByDispatcher();
      res.json(dispatchers);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch dispatcher data' });
    }
  });

  return router;
}
