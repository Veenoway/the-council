// ============================================================
// API ROUTES — Main router
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { botsRouter } from './bots.js';
import { positionsRouter } from './positions.js';
import { statsRouter } from './stats.js';

export const apiRouter = new Hono();

// CORS
apiRouter.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

// Health check
apiRouter.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount routers
apiRouter.route('/bots', botsRouter);
apiRouter.route('/positions', positionsRouter);
apiRouter.route('/stats', statsRouter);

export default apiRouter;