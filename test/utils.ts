/**
 * Pure HTTP test client for ShvmDB.
 * Hits a real dev server (wrangler dev) — no mocked workers.
 * 
 * Configure server URL via TEST_URL env var (default: http://localhost:8787)
 */

const BASE_URL = process.env.TEST_URL || "http://localhost:8787";

export class TestClient {
    private baseUrl: string;

    constructor(baseUrl?: string) {
        this.baseUrl = baseUrl || BASE_URL;
    }

    async fetch(path: string, init?: RequestInit): Promise<Response> {
        const url = new URL(path, this.baseUrl).toString();
        return fetch(url, init);
    }

    async dynamoRequest(target: string, body: any): Promise<Response> {
        return this.fetch("/api", {
            method: "POST",
            headers: {
                "x-amz-target": target,
                "Content-Type": "application/x-amz-json-1.0"
            },
            body: JSON.stringify(body)
        });
    }

    // --- Helper Methods ---

    async createTable(tableName: string, opts?: {
        hashKey?: string;
        rangeKey?: string;
        hashType?: "S" | "N" | "B";
        rangeType?: "S" | "N" | "B";
    }): Promise<Response> {
        const hashKey = opts?.hashKey || "PK";
        const rangeKey = opts?.rangeKey;
        const hashType = opts?.hashType || "S";
        const rangeType = opts?.rangeType || "S";

        const keySchema: any[] = [{ AttributeName: hashKey, KeyType: "HASH" }];
        const attrDefs: any[] = [{ AttributeName: hashKey, AttributeType: hashType }];

        if (rangeKey) {
            keySchema.push({ AttributeName: rangeKey, KeyType: "RANGE" });
            attrDefs.push({ AttributeName: rangeKey, AttributeType: rangeType });
        }

        return this.dynamoRequest("DynamoDB_20120810.CreateTable", {
            TableName: tableName,
            KeySchema: keySchema,
            AttributeDefinitions: attrDefs,
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        });
    }

    async deleteTable(tableName: string): Promise<Response> {
        return this.dynamoRequest("DynamoDB_20120810.DeleteTable", {
            TableName: tableName
        });
    }

    async putItem(tableName: string, item: Record<string, any>): Promise<Response> {
        return this.dynamoRequest("DynamoDB_20120810.PutItem", {
            TableName: tableName,
            Item: item
        });
    }

    async getItem(tableName: string, key: Record<string, any>): Promise<Response> {
        return this.dynamoRequest("DynamoDB_20120810.GetItem", {
            TableName: tableName,
            Key: key
        });
    }

    async deleteItem(tableName: string, key: Record<string, any>): Promise<Response> {
        return this.dynamoRequest("DynamoDB_20120810.DeleteItem", {
            TableName: tableName,
            Key: key
        });
    }

    async listTables(limit?: number): Promise<Response> {
        return this.dynamoRequest("DynamoDB_20120810.ListTables", {
            Limit: limit
        });
    }

    async describeTable(tableName: string): Promise<Response> {
        return this.dynamoRequest("DynamoDB_20120810.DescribeTable", {
            TableName: tableName
        });
    }

    /** Generate a unique table name for test isolation */
    static uniqueTableName(prefix: string = "Test"): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /** Extract debug headers from response */
    static getDebugHeaders(res: Response): Record<string, string> {
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
            if (key.toLowerCase().startsWith("x-shivam-db")) {
                headers[key] = value;
            }
        });
        return headers;
    }
}
