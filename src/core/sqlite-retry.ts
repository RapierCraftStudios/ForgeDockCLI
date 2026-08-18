// SPDX-License-Identifier: AGPL-3.0-or-later

import { setTimeout as sleep } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 10_000;
export const SQLITE_BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

// DatabaseSync constructors cannot await a promise, but SQLite's journal-mode
// transition may still report SQLITE_BUSY before its busy handler is engaged.
// A tiny shared wait array gives the synchronous initialization path the same
// bounded retry policy as the async repository operations.
const SQLITE_BUSY_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export function initializeSqliteDatabase(database: DatabaseSync, schema: string): void {
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  withSqliteBusyRetrySync(() => database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;"));
  // Changing journal mode may replace SQLite's busy handler.
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  withSqliteBusyRetrySync(() => database.exec(schema));
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /database is locked|database is busy|SQLITE_(?:BUSY|LOCKED)/i.test(message);
}

export function withSqliteBusyRetrySync<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
      if (!isSqliteBusyError(error) || delay === undefined) throw error;
      Atomics.wait(SQLITE_BUSY_WAIT_ARRAY, 0, 0, delay);
    }
  }
}

export async function withSqliteBusyRetry<T>(operation: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
      if (!isSqliteBusyError(error) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
