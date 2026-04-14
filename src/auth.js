// Authentication helpers + middleware.
// Uses bcryptjs (pure-JS) so npm install never fails on native build issues.

import bcrypt from 'bcryptjs';
import { query } from './db/index.js';
// attachUser references `query` for the active-job lookup.

const SALT_ROUNDS = 12;

export async function createUser({ email, name, password }) {
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name
     RETURNING id, email, name, created_at;`,
    [email.toLowerCase().trim(), name || null, password_hash]
  );
  return rows[0];
}

export async function verifyLogin(email, password) {
  const { rows } = await query(
    `SELECT id, email, name, password_hash FROM users WHERE email = $1;`,
    [email.toLowerCase().trim()]
  );
  const user = rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1;`, [user.id]);
  return { id: user.id, email: user.email, name: user.name };
}

export async function getUserById(id) {
  const { rows } = await query(
    `SELECT id, email, name FROM users WHERE id = $1;`,
    [id]
  );
  return rows[0] || null;
}

// Middleware: redirect to /login if not authenticated (HTML pages)
export function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.accepts('html')) {
    const next_url = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${next_url}`);
  }
  return res.status(401).json({ error: 'unauthorized' });
}

// Middleware: 401 JSON if not authenticated (API endpoints)
export function requireAuthApi(req, res, next) {
  if (req.session?.userId) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Attach the current user + any active discovery job to res.locals so every
// EJS template can render the "discovery in progress" banner regardless of
// which page the operator navigated to.
export async function attachUser(req, res, next) {
  if (req.session?.userId) {
    res.locals.user = await getUserById(req.session.userId);
    // Most-recent running job, OR completed/failed job from the last 60s
    // (so the user sees the result banner briefly after finish).
    const { rows } = await query(
      `SELECT id, status, requested_count, discovered_count, drafted_count, skipped_count, error,
              started_at, finished_at
         FROM discovery_jobs
        WHERE user_id = $1
          AND (status = 'running' OR finished_at > NOW() - INTERVAL '60 seconds')
        ORDER BY started_at DESC
        LIMIT 1`,
      [req.session.userId]
    );
    res.locals.activeJob = rows[0] || null;
  } else {
    res.locals.user = null;
    res.locals.activeJob = null;
  }
  next();
}
