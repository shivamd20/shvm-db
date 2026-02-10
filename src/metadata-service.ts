import { TableMetadata } from "./types";
import { TableRegistryDO } from "./table-registry-do";
import { Env } from "./index";

export class MetadataService {
    private env: Env;
    private registry: DurableObjectStub<TableRegistryDO>;

    constructor(env: Env) {
        this.env = env;
        // Global singleton registry
        const id = env.TABLE_REGISTRY_DO.idFromName("global-registry");
        this.registry = env.TABLE_REGISTRY_DO.get(id);
    }

    private getCacheKey(tableName: string): string {
        return `table_meta:${tableName}`;
    }

    async getTableMetadata(tableName: string): Promise<TableMetadata> {
        const cacheKey = this.getCacheKey(tableName);

        // 1. Try KV Cache
        try {
            const cached = await this.env.TABLE_METADATA_CACHE.get<TableMetadata>(cacheKey, "json");
            if (cached) {
                return cached;
            }
        } catch (e) {
            console.warn("KV Cache lookup failed", e);
        }

        // 2. Fallback to Registry DO
        const metadata = await this.registry.getTable(tableName);

        if (!metadata) {
            throw new Error(`Table not found: ${tableName}`);
        }

        // 3. Update KV Cache (24h TTL)
        try {
            await this.env.TABLE_METADATA_CACHE.put(cacheKey, JSON.stringify(metadata), {
                expirationTtl: 86400 // 24 hours
            });
        } catch (e) {
            console.warn("KV Cache update failed", e);
        }

        return metadata;
    }

    async createTable(input: any): Promise<any> {
        return await this.registry.createTable(input);
    }

    async deleteTable(tableName: string): Promise<any> {
        const result = await this.registry.deleteTable(tableName);
        if (!result) {
            throw new Error(`Table not found: ${tableName}`); // Will be converted to ResourceNotFoundException in index.ts
        }

        // Invalidate Cache
        const cacheKey = this.getCacheKey(tableName);
        await this.env.TABLE_METADATA_CACHE.delete(cacheKey);

        return result;
    }
}

