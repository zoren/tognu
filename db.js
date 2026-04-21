import Database from 'better-sqlite3';

export const DB_PATH = process.env.TOGNU_DB ?? './tognu.db';

export function openDb(path = DB_PATH) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS departures (
      line TEXT NOT NULL,
      train_number TEXT NOT NULL,
      station_id TEXT NOT NULL,
      aimed_time TEXT,
      expected_time TEXT,
      destination TEXT,
      destination_station_id TEXT,
      track TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (line, train_number, station_id)
    );
    CREATE INDEX IF NOT EXISTS idx_departures_station_time
      ON departures(station_id, expected_time, aimed_time);
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT
    );
  `);
  return db;
}
