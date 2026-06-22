import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  const sql = readFileSync(resolve(__dirname, '../schema.sql'), 'utf8');
  console.log('[migrate] aplicando schema...');
  await query(sql);
  console.log('[migrate] ok');
  process.exit(0);
}

run().catch((e) => {
  console.error('[migrate] falhou:', e);
  process.exit(1);
});
