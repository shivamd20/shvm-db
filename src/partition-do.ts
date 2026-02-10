import { DurableObject } from "cloudflare:workers";
import { SubDO } from "./sub-do";
import { LRUCache, BloomFilter } from "./cache";
import { BLOOM_FILTER_SIZE, LRU_CACHE_CAPACITY } from "./constants";


export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
}

export class PartitionDO extends DurableObject {
    lru: LRUCache<string, unknown>;
    bf: BloomFilter;
    private lastSave: Promise<void> = Promise.resolve();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.lru = new LRUCache(LRU_CACHE_CAPACITY);
        // Partition level can be bigger. 128KB = ~1M bits (approx 100k items)
        this.bf = new BloomFilter(BLOOM_FILTER_SIZE);


        this.ctx.blockConcurrencyWhile(async () => {
            const storedBf = await this.ctx.storage.get("bloom_filter");
            if (storedBf && typeof storedBf === 'string') {
                this.bf = BloomFilter.deserialize(storedBf, BLOOM_FILTER_SIZE);

            }
        });
    }

    private getSubDO(sk: string): DurableObjectStub<SubDO> {
        // Simple consistent hashing: hash(sk) % 100
        let hash = 0;
        for (let i = 0; i < sk.length; i++) {
            hash = ((hash << 5) - hash) + sk.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        const partitionId = Math.abs(hash) % 100;
        const subDoId = this.env.SUB_DO.idFromName(`sub-partition-${partitionId}`);
        return this.env.SUB_DO.get(subDoId);
    }

    async putItem(sk: string, value: unknown): Promise<void> {
        // Write-through to SubDO first for integrity
        const subDo = this.getSubDO(sk);
        await subDo.putItem(sk, value);

        // Update local cache
        this.lru.put(sk, value);

        // Update Bloom Filter and persist safely
        if (!this.bf.has(sk)) {
            this.bf.add(sk);

            // Serialize immediately to capture current state
            const serialized = this.bf.serialize();

            // Chain writes to ensure order is preserved and no data is lost upon overwrite
            this.lastSave = this.lastSave
                .then(() => this.ctx.storage.put("bloom_filter", serialized))
                .catch(err => {
                    console.error("Failed to save BloomFilter", err);
                    // Critical error: persistence failed. 
                    // We might not crash the request, but we have a consistency risk on restart.
                });

            await this.lastSave;
        } else {
            this.lru.put(sk, value);
        }
    }

    async getItem(sk: string): Promise<unknown | null> {
        // Check local cache
        const cached = this.lru.get(sk);
        if (cached !== undefined) return cached;

        // Check Bloom Filter (Negative Cache)
        if (!this.bf.has(sk)) return null;

        const subDo = this.getSubDO(sk);
        const value = await subDo.getItem(sk);

        if (value !== null) {
            this.lru.put(sk, value);
        }
        return value;
    }

    async deleteItem(sk: string): Promise<void> {
        const subDo = this.getSubDO(sk);
        await subDo.deleteItem(sk);
        this.lru.remove(sk);
        // Bloom Filter cannot easily delete items without rebuilding
    }
}
