import { createLogger } from "./debug";

export class CacheManager {
    private readonly cache: Cache;
    private readonly log: (component: string, ...args: any[]) => void;

    constructor(env?: any) {
        this.cache = (caches as any).default;
        this.log = createLogger(env);
    }

    private getCacheKey(type: "item" | "table", key: string): Request {
        return new Request(`https://shvm-db.local/cache/${type}/${encodeURIComponent(key)}`);
    }

    async getItem<T>(type: "item" | "table", key: string): Promise<T | null> {
        const req = this.getCacheKey(type, key);
        try {
            const res = await this.cache.match(req);
            if (res) {
                const data = await res.json() as any;
                if (data && data._deleted) return null;
                return data as T;
            }
        } catch (err) {
            this.log("cache", `Parse error on match for ${type}/${key}:`, err);
        }
        return null;
    }

    async getItemRaw(type: "item" | "table", key: string): Promise<{ hit: boolean; deleted: boolean; raw?: string; data?: any }> {
        const req = this.getCacheKey(type, key);
        try {
            const res = await this.cache.match(req);
            if (res) {
                const text = await res.text();
                const data = JSON.parse(text);
                if (data && data._deleted) return { hit: true, deleted: true, raw: text, data };
                return { hit: true, deleted: false, raw: text, data };
            }
        } catch (err) {
            this.log("cache", `Parse error on raw match for ${type}/${key}:`, err);
        }
        return { hit: false, deleted: false };
    }


    async putItem(ctx: ExecutionContext, type: "item" | "table", key: string, data: any, ttlSeconds: number): Promise<void> {
        const req = this.getCacheKey(type, key);
        const res = new Response(JSON.stringify(data), {
            headers: {
                "Cache-Control": `max-age=${ttlSeconds}`
            }
        });

        // WaitUntil is required because Cloudflare caches do not naturally await response streams inside worker isolates that close immediately
        ctx.waitUntil(this.cache.put(req, res));
    }

    async deleteItem(ctx: ExecutionContext, type: "item" | "table", key: string, ttlSeconds: number): Promise<void> {
        // Write a tombstone rather than doing caches.delete() to avoid thundering-herd on misses
        const req = this.getCacheKey(type, key);
        const res = new Response(JSON.stringify({ _deleted: true }), {
            headers: {
                "Cache-Control": `max-age=${ttlSeconds}`
            }
        });
        ctx.waitUntil(this.cache.put(req, res));
    }
}
