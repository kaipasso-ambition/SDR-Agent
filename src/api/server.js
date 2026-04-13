import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import expressLayouts from 'express-ejs-layouts';

import { router as apiRouter } from './routes.js';
import { webRouter } from '../web/routes.js';
import { attachUser, requireAuthApi } from '../auth.js';
import { pool } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIEWS_DIR = path.resolve(__dirname, '..', 'views');

const PgStore = connectPgSimple(session);

export function createServer() {
  const app = express();

  // Required so express-session sees the real client IP + HTTPS when behind
  // Railway / Render / Fly / any reverse proxy. Without this, secure cookies
  // won't be sent and sessions break in production.
  app.set('trust proxy', 1);

  // View engine
  app.set('views', VIEWS_DIR);
  app.set('view engine', 'ejs');
  app.use(expressLayouts);
  app.set('layout', 'layout');

  // Body parsers
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Session
  if (!process.env.SESSION_SECRET) {
    console.warn('[api] WARNING: SESSION_SECRET not set in .env. Sessions will not survive a restart.');
  }
  app.use(
    session({
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET || 'dev-only-not-secure',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
      },
    })
  );

  // Make req.user / res.locals.user available everywhere
  app.use(attachUser);

  // Routes
  app.use('/api', requireAuthApi, apiRouter); // /api/health stays unauthenticated below
  app.get('/healthz', (_req, res) => res.json({ ok: true })); // unauthenticated liveness probe
  app.use('/', webRouter);

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error('[server] error:', err);
    if (res.headersSent) return;
    if (_req?.accepts && _req.accepts('html') && !_req.path.startsWith('/api')) {
      return res.status(500).send(`<pre>${err.message || 'internal_error'}</pre>`);
    }
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
