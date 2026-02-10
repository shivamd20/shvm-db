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


        // Initialize Schema - Simple Key-Value and Metadata
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            );
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

    private validateRouting(sk: string, partitionId: number, totalPartitions: number) {
        // 1. Verify Sort Key belongs to Partition
        let hash = 0;
        for (let i = 0; i < sk.length; i++) {
            hash = ((hash << 5) - hash) + sk.charCodeAt(i);
            hash |= 0;
        }
        const calculatedPartition = Math.abs(hash) % totalPartitions;

        if (calculatedPartition !== partitionId) {
            throw new Error(`Misrouted request: Key ${sk} belongs to partition ${calculatedPartition}, but request targets ${partitionId}`);
        }

        // 2. Verify THIS DO is authoritative for partitionId
        // Check persistent storage for ownership
        const stored = Array.from(this.sql.exec("SELECT value FROM metadata WHERE key = ?", "partition_id"));
        let storedId = -1;
        if (stored.length > 0) {
            storedId = parseInt(stored[0].value as string);
        }

        if (storedId === -1) {
            // Trust On First Use (TOFU)
            this.sql.exec("INSERT INTO metadata (key, value) VALUES (?, ?)", "partition_id", partitionId.toString());
        } else if (storedId !== partitionId) {
            throw new Error(`Wrong PartitionDO: I own partition ${storedId}, but you requested ${partitionId}. Redirect needed.`);
        }
    }

    async putItem(sk: string, value: unknown, partitionId: number, totalPartitions: number): Promise<void> {
        this.validateRouting(sk, partitionId, totalPartitions);
        this.sql.exec(`
            INSERT OR REPLACE INTO items (sk, value) VALUES (?, ?)
        `, sk, JSON.stringify(value));
        // Update cache after successful DB write
        this.lru.put(sk, value);
        this.bf.add(sk);
    }

    async getItem(sk: string, partitionId: number, totalPartitions: number): Promise<unknown | null> {
        this.validateRouting(sk, partitionId, totalPartitions);
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

    async deleteItem(sk: string, partitionId: number, totalPartitions: number): Promise<void> {
        this.validateRouting(sk, partitionId, totalPartitions);
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
