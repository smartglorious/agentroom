import type { Database, RunResult } from "@appthreat/sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqliteValue = null | string | number | bigint | Buffer;
export type SqliteParams = readonly SqliteValue[] | Record<string, SqliteValue>;

export interface SqliteRunResult {
  lastId: number;
  changes: number;
}

export interface SqliteHealth {
  sqliteVersion: string;
  journalMode: string;
  foreignKeys: boolean;
  fts5: boolean;
  busyTimeoutMs: number;
}

export interface OpenSqliteOptions {
  busyTimeoutMs?: number;
}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/**
 * Small promise-based boundary around the native driver. Domain/repository code
 * depends on this class, never on @appthreat/sqlite3 directly.
 */
export class SqliteConnection {
  private closed = false;
  private transactionTail: Promise<void> = Promise.resolve();

  private constructor(private readonly db: Database, readonly file: string, readonly health: SqliteHealth) {}

  static async open(file: string, options: OpenSqliteOptions = {}): Promise<SqliteConnection> {
    if (!file.trim()) throw new Error("SQLite path is empty");
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error(`Invalid SQLite busy timeout: ${busyTimeoutMs}`);
    }
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const sqlite3 = await import("@appthreat/sqlite3");
    const db = await new Promise<Database>((resolve, reject) => {
      let opened!: Database;
      opened = new sqlite3.Database(file, (err: Error | null) => err ? reject(err) : resolve(opened));
    });
    db.configure("busyTimeout", busyTimeoutMs);
    const conn = new SqliteConnection(db, file, { sqliteVersion: "", journalMode: "", foreignKeys: false, fts5: false, busyTimeoutMs });
    try {
      await conn.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
      const journal = await conn.get<{ journal_mode: string }>("PRAGMA journal_mode = WAL");
      const version = await conn.get<{ sqlite_version: string }>("SELECT sqlite_version() AS sqlite_version");
      const foreignKeys = await conn.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
      const compiled = await conn.get<{ enabled: number }>("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled");
      await conn.exec("CREATE VIRTUAL TABLE temp.__agentroom_fts5_probe USING fts5(body); DROP TABLE temp.__agentroom_fts5_probe;");
      conn.health.sqliteVersion = version?.sqlite_version ?? "unknown";
      conn.health.journalMode = journal?.journal_mode ?? "unknown";
      conn.health.foreignKeys = foreignKeys?.foreign_keys === 1;
      conn.health.fts5 = compiled?.enabled === 1;
      if (!conn.health.foreignKeys) throw new Error("SQLite foreign keys could not be enabled");
      if (!conn.health.fts5) throw new Error("SQLite build does not provide FTS5");
      if (file !== ":memory:" && conn.health.journalMode.toLowerCase() !== "wal") throw new Error(`SQLite WAL could not be enabled (got ${conn.health.journalMode})`);
      return conn;
    } catch (e) {
      await conn.close().catch(() => undefined);
      throw asError(e);
    }
  }

  private ensureOpen() {
    if (this.closed) throw new Error("SQLite connection is closed");
  }

  async exec(sql: string): Promise<void> {
    this.ensureOpen();
    await new Promise<void>((resolve, reject) => this.db.exec(sql, (err) => err ? reject(err) : resolve()));
  }

  async run(sql: string, params: SqliteParams = []): Promise<SqliteRunResult> {
    this.ensureOpen();
    return await new Promise((resolve, reject) => {
      this.db.run(sql, params, function (this: RunResult, err) {
        if (err) reject(err);
        else resolve({ lastId: this.lastID, changes: this.changes });
      });
    });
  }

  async get<T>(sql: string, params: SqliteParams = []): Promise<T | undefined> {
    this.ensureOpen();
    return await new Promise((resolve, reject) => this.db.get<T>(sql, params, (err, row) => err ? reject(err) : resolve(row)));
  }

  async all<T>(sql: string, params: SqliteParams = []): Promise<T[]> {
    this.ensureOpen();
    return await new Promise((resolve, reject) => this.db.all<T>(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  }

  /** Transactions are queued on this connection so two application commands cannot interleave. */
  async transaction<T>(fn: (tx: SqliteConnection) => Promise<T>): Promise<T> {
    this.ensureOpen();
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const value = await fn(this);
        await this.exec("COMMIT");
        return value;
      } catch (e) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw e;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.transactionTail;
    this.closed = true;
    await closeRaw(this.db);
  }
}

const closeRaw = (db: Database) => new Promise<void>((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
