#!/usr/bin/env node
/**
 * Create an invite directly in D1, e.g. the bootstrap invite for the first
 * account (which becomes the instance admin).
 *
 *   pnpm --filter @koode/server invite:create              # local dev database
 *   pnpm --filter @koode/server invite:create --days 3
 *   pnpm --filter @koode/server invite:create --remote     # deployed database (be sure!)
 *
 * The code is printed once and only its SHA-256 hash is stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 7;
if (!Number.isInteger(days) || days < 1 || days > 30) {
  console.error('--days must be an integer from 1 to 30');
  process.exit(1);
}

const code = Array.from(randomBytes(12), (b) => ALPHABET[b % 32]).join('');
const hash = createHash('sha256').update(code).digest('hex');
const id = `inv_${randomBytes(12).toString('base64url')}`;
const now = Date.now();
const expires = now + days * 86_400_000;

// Values are generated here (hex / base64url / integers), never user input.
const sql = `INSERT INTO invites (id, code_hash, created_by, max_uses, use_count, expires_at, created_at) VALUES ('${id}', '${hash}', NULL, 1, 0, ${expires}, ${now});`;

execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local', '--command', sql],
  {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);

console.log(
  `\nInvite code (${remote ? 'REMOTE' : 'local'} database, valid ${days} days, single use):\n`,
);
console.log(`  ${code.match(/.{4}/g).join('-')}\n`);
