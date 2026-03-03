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

    async getTableMetadata(tableName: string): Promise<{ metadata: TableMetadata; fromCache: boolean }> {
        const metadata = await this.registry.getTable(tableName);
        if (!metadata) {
            throw new Error(`Cannot do operations on a non-existent table`);
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

        return result;
    }
}

