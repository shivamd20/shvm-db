import { DurableObject } from "cloudflare:workers";
import { LRUCache, BloomFilter } from "./cache";
import { BLOOM_FILTER_SIZE, LRU_CACHE_CAPACITY } from "./constants";
import type { PartitionDO } from "./partition-do";

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
    [key: string]: any;
}

export class SubDO extends DurableObject {
    sql: SqlStorage;
    lru: LRUCache<string, unknown>;
    bf: BloomFilter;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.lru = new LRUCache(LRU_CACHE_CAPACITY); // Keep reasonable size
        this.bf = new BloomFilter(BLOOM_FILTER_SIZE); // 128KB


        // Initialize Schema - Simple Key-Value for now
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS items (
                sk TEXT PRIMARY KEY,
                value BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_sk ON items(sk);
        `);

        // Rebuild Bloom Filter from DB - SQL is sync, fast for small partitions
        try {
            const cursor = this.sql.exec("SELECT sk FROM items");
            for (const row of cursor) {
                this.bf.add(row.sk as string);
            }
        } catch (e) {
            console.error("Failed to recover BloomFilter", e);
        }
    }

    async putItem(sk: string, value: unknown): Promise<void> {
        this.sql.exec(`
            INSERT OR REPLACE INTO items (sk, value) VALUES (?, ?)
        `, sk, JSON.stringify(value));
        // Update cache after successful DB write
        this.lru.put(sk, value);
        this.bf.add(sk);
    }

    async getItem(sk: string): Promise<unknown | null> {
        // Check cache first
        const cached = this.lru.get(sk);
        if (cached !== undefined) return cached;

        // Check Bloom Filter
        if (!this.bf.has(sk)) return null;

        const cursor = this.sql.exec(`
            SELECT value FROM items WHERE sk = ?
        `, sk);

        const results = Array.from(cursor);
        if (results.length === 0) return null;

        const value = JSON.parse(results[0].value as string);
        this.lru.put(sk, value);
        return value;
    }

    async deleteItem(sk: string): Promise<void> {
        this.lru.remove(sk);
        // Note: Bloom Filter doesn't support deletion without rebuilding or Counting BF
        this.sql.exec(`
            DELETE FROM items WHERE sk = ?
        `, sk);
    }

    async query(prefix: string): Promise<unknown[]> {
        throw new Error("Not Implemented: Query is not supported in this MVP.");
    }
}
