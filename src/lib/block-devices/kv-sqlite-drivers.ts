/**
 * Adapter factories that wrap a real-world SQLite client into the
 * shape {@link KvBlockDeviceSqlite3} expects ({@link KvSqliteDriver}).
 *
 * Both adapters use **type-only imports** of their underlying client,
 * so this module is safe to load under any runtime — the type imports
 * are erased at compile time, and calling `wrapBunSqliteDatabase`
 * needs a `bun:sqlite` `Database` you couldn't have constructed
 * outside Bun anyway.
 */
import type { Database as BunSqliteDatabase, SQLQueryBindings } from 'bun:sqlite';
import type { AsyncDatabase } from 'promised-sqlite3';
import { KvSqliteDriver } from './kv-block-device-sqlite3';

/**
 * Wrap a `bun:sqlite` `Database`. `bun:sqlite` is synchronous and
 * built into Bun — fastest path under Bun, no native compile, no
 * postinstall trust dance.
 *
 * Pick this when running under Bun. Under Node it'll typecheck but
 * you can't get a `BunSqliteDatabase` to pass in.
 */
export function wrapBunSqliteDatabase(database: BunSqliteDatabase): KvSqliteDriver {
    return {
        run: async (sql: string, ...params: unknown[]): Promise<void> => {
            database.prepare(sql).run(...params as SQLQueryBindings[]);
        },
        get: async <T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> => {
            const row = database.prepare(sql).get(...params as SQLQueryBindings[]);
            // bun:sqlite returns null for "no row"; KvSqliteDriver
            // promises undefined. Normalise.
            return (row ?? undefined) as T | undefined;
        },
        close: async (): Promise<void> => {
            database.close();
        },
    };
}

/**
 * Wrap a `promised-sqlite3` `AsyncDatabase` (which itself sits on top
 * of the npm `sqlite3` package). Pick this when running under Node —
 * `bun:sqlite` doesn't exist there. Works under Bun too via Bun's
 * shim of the npm `sqlite3` package, but `bun:sqlite` is faster.
 */
export function wrapAsyncDatabase(database: AsyncDatabase): KvSqliteDriver {
    return {
        run: async (sql: string, ...params: unknown[]): Promise<void> => {
            await database.run(sql, ...params);
        },
        get: async <T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> => {
            return await database.get<T>(sql, ...params);
        },
        close: async (): Promise<void> => {
            await database.close();
        },
    };
}
