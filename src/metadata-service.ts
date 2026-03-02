import { TableMetadata } from "./types";
import { TableRegistryDO } from "./table-registry-do";
import { Env } from "./index";
import { createLogger } from "./debug";

export class MetadataService {
    private env: Env;
    private registry: DurableObjectStub<TableRegistryDO>;
    private log;

    constructor(env: Env, registryStub?: DurableObjectStub<TableRegistryDO>) {
        this.env = env;
        this.log = createLogger(env);
        this.registry = registryStub ?? env.TABLE_REGISTRY_DO.get(env.TABLE_REGISTRY_DO.idFromName("global-registry"));
    }

    private getCacheKey(tableName: string): string {
        return `table_meta:${tableName}`;
    }

    async getTableMetadata(tableName: string): Promise<{ metadata: TableMetadata; fromCache: boolean }> {
        const cacheKey = this.getCacheKey(tableName);

        try {
            const cached = await this.env.TABLE_METADATA_CACHE.get<TableMetadata>(cacheKey, "json");
            if (cached) {
                return { metadata: cached, fromCache: true };
            }
        } catch (e) {
            this.log.warn("MetadataService", "KV cache lookup failed", e);
        }

        const metadata = await this.registry.getTable(tableName);
        if (!metadata) {
            throw new Error(`Cannot do operations on a non-existent table`);
        }

        try {
            await this.env.TABLE_METADATA_CACHE.put(cacheKey, JSON.stringify(metadata), {
                expirationTtl: 86400
            });
        } catch (e) {
            this.log.warn("MetadataService", "KV cache update failed", e);
        }

        return { metadata, fromCache: false };
    }

    async createTable(input: any): Promise<any> {
        return await this.registry.createTable(input);
    }

    async deleteTable(tableName: string): Promise<any> {
        const result = await this.registry.deleteTable(tableName);
        if (!result) {
            throw new Error(`Cannot do operations on a non-existent table`);
        }

        // Invalidate Cache (best-effort)
        try {
            const cacheKey = this.getCacheKey(tableName);
            await this.env.TABLE_METADATA_CACHE.delete(cacheKey);
        } catch (e) {
            this.log.warn("MetadataService", "KV cache invalidation failed (non-critical)", e);
        }

        return result;
    }
}

