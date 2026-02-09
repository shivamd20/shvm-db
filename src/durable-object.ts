import { DurableObject } from "cloudflare:workers";

export interface Env {
    MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
}

export class MyDurableObject extends DurableObject {
    sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;

        // Initialize Schema
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
        // Use iterator to avoid exception if no result found
        const cursor = this.sql.exec(`
			SELECT value FROM items WHERE sk = ?
		`, sk);

        const results = Array.from(cursor);
        if (results.length === 0) return null;

        return JSON.parse(results[0].value as string);
    }

    async query(prefix: string): Promise<unknown[]> {
        // Simple prefix scan for now, matching README "Range on Sort Key"
        const results = this.sql.exec(`
			SELECT value FROM items WHERE sk LIKE ? ORDER BY sk ASC
		`, `${prefix}%`); // This is a rough approximation of "begins_with"

        // For true DynamoDB query, we'd need start/end range support.
        // Detailed implementation can come later.

        const items: unknown[] = [];
        for (const row of results) {
            items.push(JSON.parse(row.value as string));
        }
        return items;
    }

    // Temporary method for initial testing
    async sayHello(name: string): Promise<string> {
        return `Hello, ${name}! Storage is ready.`;
    }
}
