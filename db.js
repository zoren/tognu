import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

// Resolved against this module, not process.cwd(): the server and the ingest
// worker have to open the same file no matter what working directory their
// service manager hands them.
export const DB_PATH =
  process.env.TOGNU_DB ?? fileURLToPath(new URL('./tognu.db', import.meta.url));

export function openDb(path = DB_PATH) {
  const db = new Database(path);
  console.log(`SQLite: ${path}`);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    DROP TABLE IF EXISTS departures;
    CREATE TABLE IF NOT EXISTS journeys (
      line TEXT NOT NULL,
      train_number TEXT NOT NULL,
      journey_key TEXT NOT NULL,
      data TEXT NOT NULL,
      earliest_time TEXT,
      latest_time TEXT,
      received_at TEXT NOT NULL,
      PRIMARY KEY (line, train_number, journey_key)
    );
    CREATE INDEX IF NOT EXISTS idx_journeys_latest ON journeys(latest_time);
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT
    );
  `);
  return db;
}
