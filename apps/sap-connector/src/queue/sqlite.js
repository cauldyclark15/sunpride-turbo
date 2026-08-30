import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class DurableQueue {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY, direction TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
    ); CREATE INDEX IF NOT EXISTS queue_due ON queue(status, direction, next_attempt_at);`);
  }
  enqueue({ id, direction, eventType, payload }) {
    this.db
      .query(
        "INSERT OR IGNORE INTO queue (id, direction, event_type, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        direction,
        eventType,
        JSON.stringify(payload),
        Date.now(),
        Date.now(),
      );
  }
  due(direction, limit = 25) {
    return this.db
      .query(
        "SELECT * FROM queue WHERE status = 'pending' AND direction = ? AND next_attempt_at <= ? ORDER BY created_at LIMIT ?",
      )
      .all(direction, Date.now(), limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  complete(id) {
    this.db
      .query(
        "UPDATE queue SET status = 'completed', completed_at = ?, last_error = NULL WHERE id = ?",
      )
      .run(Date.now(), id);
  }
  fail(id, error) {
    const row = this.db
      .query("SELECT attempts FROM queue WHERE id = ?")
      .get(id);
    if (!row) return;
    const attempts = row.attempts + 1;
    const status = attempts >= 10 ? "dead_letter" : "pending";
    const nextAttemptAt = Date.now() + Math.min(300_000, 1_000 * 2 ** attempts);
    this.db
      .query(
        "UPDATE queue SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
      )
      .run(attempts, status, nextAttemptAt, String(error).slice(0, 1000), id);
  }
  stats() {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS count FROM queue GROUP BY status")
      .all();
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
  close() {
    this.db.close();
  }
}
