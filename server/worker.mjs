import { createPool, migrate, releaseExpiredReservations } from './db.mjs';
import { releaseSearch } from './credit-ledger.mjs';
import { refreshTrackedTopic } from './search-service.mjs';
import { setTimeout } from 'node:timers/promises';

if (!process.env.DATABASE_URL) throw new Error('A separate worker requires DATABASE_URL. Use BACKGROUND_COLLECTION=true for a single-process PGlite dev server.');
const pool = await createPool();
await migrate(pool);
let stopped = false;
process.on('SIGTERM',()=>{stopped=true;});
process.on('SIGINT',()=>{stopped=true;});
while (!stopped) {
  try {
    await releaseExpiredReservations(pool,releaseSearch);
    await refreshTrackedTopic(pool);
  } catch(error) {console.error(JSON.stringify({event:'worker_failed',code:error.code || 'COLLECTION_FAILED'}));}
  if (!stopped) await setTimeout(10000);
}
await pool.end();
