import { DurableObject } from "cloudflare:workers";
import { TableMetadata, CreateTableInput, TableDescription } from "./types";

export class TableRegistryDO extends DurableObject {
    async createTable(input: CreateTableInput): Promise<TableDescription> {
        const existing = await this.ctx.storage.get<TableMetadata>(input.TableName);
        if (existing) {
            throw new Error(`Table ${input.TableName} already exists`);
        }

        const metadata: TableMetadata = {
            TableName: input.TableName,
            KeySchema: input.KeySchema,
            AttributeDefinitions: input.AttributeDefinitions,
            TableStatus: "ACTIVE", // Simulating instant creation
            CreationDateTime: Date.now() / 1000,
            ProvisionedThroughput: input.ProvisionedThroughput
        };

        await this.ctx.storage.put(input.TableName, metadata);
        return { Table: metadata };
    }

    async deleteTable(tableName: string): Promise<TableDescription | null> {
        const metadata = await this.ctx.storage.get<TableMetadata>(tableName);
        if (!metadata) {
            return null; // Or throw ResourceNotFoundException
        }

        // Mark as DELETING (optional state transition)
        metadata.TableStatus = "DELETING";
        await this.ctx.storage.put(tableName, metadata);

        // Actually delete from storage
        await this.ctx.storage.delete(tableName);

        return { Table: metadata };
    }

    async getTable(tableName: string): Promise<TableMetadata | null> {

        const metadata = await this.ctx.storage.get<TableMetadata>(tableName);
        return metadata || null;
    }

    async listTables(limit?: number, startKey?: string): Promise<string[]> {
        const options: DurableObjectListOptions = {
            limit: limit || 100,
            startAfter: startKey
        };
        const tables = await this.ctx.storage.list<TableMetadata>(options);
        return Array.from(tables.keys());
    }
}
