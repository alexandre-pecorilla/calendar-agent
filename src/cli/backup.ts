import { openDatabase, backupDatabase } from '../db/sqlite.js';

/** `make db-backup`: consistent snapshot of the live database to a path. */
const dest = process.argv[2];
if (!dest) {
  console.error('usage: backup <destination.db>');
  process.exit(2);
}
const db = openDatabase(process.env.DATA_DIR ?? '/data');
await backupDatabase(db, dest);
db.close();
console.log(`backup written: ${dest}`);
