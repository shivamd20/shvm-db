import { DurableObject } from "cloudflare:workers";

export interface Env { }

export class SubDO extends DurableObject {
    sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;

        // Initialize Schema - Simple Key-Value for now
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS items (
                sk TEXT PRIMARY KEY,
                value BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_sk ON items(sk);
        `);
    }

    async putItem(sk: string, value: unknown): Promise<void> {
        this.sql.exec(`
            INSERT OR REPLACE INTO items (sk, value) VALUES (?, ?)
        `, sk, JSON.stringify(value));
    }

    async getItem(sk: string): Promise<unknown | null> {
        const cursor = this.sql.exec(`
            SELECT value FROM items WHERE sk = ?
        `, sk);

        const results = Array.from(cursor);
        if (results.length === 0) return null;

        return JSON.parse(results[0].value as string);
    }

    async deleteItem(sk: string): Promise<void> {
        this.sql.exec(`
            DELETE FROM items WHERE sk = ?
        `, sk);
    }

    async query(prefix: string): Promise<unknown[]> {
        throw new Error("Not Implemented: Query is not supported in this MVP.");
    }
}
