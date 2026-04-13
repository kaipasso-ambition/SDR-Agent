// Create or update a UI login.
// Usage:
//   node scripts/create_user.js <email> <password> [name]
//
// Example:
//   node scripts/create_user.js kai@ambition.com "MyStrongPass!2026" "Kai Passo"
//
// Re-running with the same email updates the password (so this is also how
// you reset a forgotten password).

import 'dotenv/config';
import { createUser } from '../src/auth.js';
import { pool } from '../src/db/index.js';

async function main() {
  const [, , email, password, ...nameParts] = process.argv;
  const name = nameParts.join(' ').trim() || null;

  if (!email || !password) {
    console.error('Usage: node scripts/create_user.js <email> <password> [name]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('That does not look like a valid email address.');
    process.exit(1);
  }

  const user = await createUser({ email, name, password });
  console.log(`OK — user ${user.email} (${user.name || 'no name'}) is ready to log in.`);
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
