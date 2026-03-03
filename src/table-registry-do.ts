import { DurableObject } from "cloudflare:workers";
import { TableMetadata, CreateTableInput, TableDescription } from "./types";
import { ValidationError } from "./validation";

export class TableRegistryDO extends DurableObject {
    async createTable(input: CreateTableInput): Promise<TableDescription> {
        if (!input.KeySchema || input.KeySchema.length === 0) {
            throw new ValidationError("No defined key schema.  A key schema containing at least a hash key must be defined for all tables");
        }

        const existing = await this.ctx.storage.get<TableMetadata>(input.TableName);
        if (existing) {
            throw new Error(`Table ${input.TableName} already exists`);
        }

        const metadata: any = {
            TableName: input.TableName,
            KeySchema: input.KeySchema || [],
            AttributeDefinitions: input.AttributeDefinitions || [],
            TableStatus: "ACTIVE", // Simulating instant creation
            CreationDateTime: Date.now() / 1000,
            ItemCount: 0,
            TableSizeBytes: 0,
            TableArn: `arn:aws:dynamodb:ddblocal:000000000000:table/${input.TableName}`,
            DeletionProtectionEnabled: false,
            ProvisionedThroughput: input.ProvisionedThroughput || {
                LastDecreaseDateTime: 0,
                LastIncreaseDateTime: 0,
                NumberOfDecreasesToday: 0,
                ReadCapacityUnits: 0,
                WriteCapacityUnits: 0
            }
        };

        if (input.BillingMode === "PAY_PER_REQUEST") {
            metadata.BillingModeSummary = {
                BillingMode: "PAY_PER_REQUEST",
                LastUpdateToPayPerRequestDateTime: Date.now() / 1000
            };
        }

        await this.ctx.storage.put(input.TableName, metadata);

        const cacheReq = new Request(`https://shvm-db.local/table/${input.TableName}`);
        const resToCache = new Response(JSON.stringify(metadata), {
            headers: { "Cache-Control": "max-age=300" }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        return { TableDescription: metadata };
    }

    async deleteTable(tableName: string): Promise<TableDescription | null> {
        const metadata = await this.ctx.storage.get<TableMetadata>(tableName);
        if (!metadata) {
            return null; // Or throw ResourceNotFoundException
        }

        const originalMetadata = { ...metadata };
        // Mark as DELETING (optional state transition)
        metadata.TableStatus = "DELETING";
        await this.ctx.storage.put(tableName, metadata);

        // Actually delete from storage
        await this.ctx.storage.delete(tableName);

        const cacheReq = new Request(`https://shvm-db.local/table/${tableName}`);
        const resToCache = new Response(JSON.stringify({ _deleted: true }), {
            headers: { "Cache-Control": "max-age=300" }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        return { TableDescription: originalMetadata };
    }

    async getTable(tableName: string): Promise<TableMetadata | null> {
        const cacheReq = new Request(`https://shvm-db.local/table/${tableName}`);
        const cacheRes = await (caches as any).default.match(cacheReq);
        if (cacheRes) {
            try {
                const data = await cacheRes.json() as any;
                if (data._deleted) return null;
                return data;
            } catch (err) { }
        }

        const metadata = await this.ctx.storage.get<TableMetadata>(tableName);

        const cacheData = metadata ? JSON.stringify(metadata) : JSON.stringify({ _deleted: true });
        const resToCache = new Response(cacheData, {
            headers: { "Cache-Control": "max-age=300" }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        return metadata || null;
    }

    async listTables(limit?: number, startKey?: string): Promise<{ TableNames: string[]; LastEvaluatedTableName?: string }> {
        // DynamoDB list tables is ordered lexicographically
        const tables = await this.ctx.storage.list<TableMetadata>();
        let tableNames = Array.from(tables.keys()).sort();

        if (startKey) {
            const startIdx = tableNames.indexOf(startKey);
            if (startIdx >= 0) {
                tableNames = tableNames.slice(startIdx + 1);
            }
        }

        const applyLimit = limit || 100;
        const resultNames = tableNames.slice(0, applyLimit);

        const result: { TableNames: string[]; LastEvaluatedTableName?: string } = {
            TableNames: resultNames
        };

        if (tableNames.length > applyLimit) {
            result.LastEvaluatedTableName = resultNames[resultNames.length - 1];
        }

        return result;
    }
}
