import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Railway / Render / Fly all require SSL but don't expose a well-known CA
// bundle inside the container. rejectUnauthorized:false is standard practice
// for these managed Postgres services; the connection is still encrypted.
const needsSsl =
  /[?&]sslmode=require/i.test(process.env.DATABASE_URL || '') ||
  process.env.NODE_ENV === 'production';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}
