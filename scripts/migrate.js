// Run db/schema.sql against the database pointed to by DATABASE_URL.
// Portable alternative to `psql -f db/schema.sql` — lets you migrate a
// hosted database (Railway, Render, etc.) without needing psql installed.
//
// Usage (local):
//   node scripts/migrate.js
//
// Usage (against a hosted database, one-off):
//   DATABASE_URL="postgresql://user:pass@host:5432/db" node scripts/migrate.js

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '..', 'db', 'schema.sql');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Pass it inline or put it in .env.');
    process.exit(1);
  }

  const sql = await fs.readFile(schemaPath, 'utf8');
  console.log(`Running schema from ${schemaPath}...`);
  console.log(`Target: ${safeUrl(process.env.DATABASE_URL)}`);

  await pool.query(sql);
  console.log('Schema applied successfully.');
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '[unparseable]';
  }
}

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
