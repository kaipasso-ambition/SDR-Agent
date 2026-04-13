import express from 'express';
import { router } from './routes.js';

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', router);

  app.use((err, _req, res, _next) => {
    console.error('[api] error:', err);
    res.status(500).json({ error: err.message || 'internal_error' });
  });

  return app;
}

export function startServer(port = process.env.PORT || 3000) {
  const app = createServer();
  return app.listen(port, () => {
    console.log(`[api] Listening on :${port}`);
  });
}
