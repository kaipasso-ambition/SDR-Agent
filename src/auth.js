// Authentication helpers + middleware.
// Uses bcryptjs (pure-JS) so npm install never fails on native build issues.

import bcrypt from 'bcryptjs';
import { query } from './db/index.js';

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

// Attach the current user to res.locals so EJS templates can use it.
export async function attachUser(req, res, next) {
  if (req.session?.userId) {
    res.locals.user = await getUserById(req.session.userId);
  } else {
    res.locals.user = null;
  }
  next();
}
