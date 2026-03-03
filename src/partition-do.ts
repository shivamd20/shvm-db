import { DurableObject } from "cloudflare:workers";
import type { TraceDO } from "./trace-do";
import { AttributeValueUpdate } from "./types";
import { createDOLogger, Logger } from "./debug";
import { PartitionDOQueries } from "./sql/queries";
import { runPartitionDOMigrations } from "./sql/migrations";
import type { TraceEvent } from "./trace-types";
import { evaluateCondition, evaluateUpdateExpression } from "./dynamo-ast";

const TRACE_DO_SINGLETON_NAME = "shvm-db-trace";
const DEFAULT_REPORT_LOAD_THRESHOLD = 10;

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    TRACE_DO?: DurableObjectNamespace<TraceDO>;
    SHVM_DEBUG?: string;
    REPORT_LOAD_THRESHOLD?: string;
    [key: string]: any;
}

export class PartitionDO extends DurableObject<Env> {
    sql: SqlStorage;
    loadCounter: number = 0;
    private log: Logger;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.log = createDOLogger(env.SHVM_DEBUG);
        runPartitionDOMigrations(this.sql);
        this.log("PartitionDO", `constructor id=${ctx.id.toString()}`);
    }

    private getReportLoadThreshold(): number {
        const v = this.env.REPORT_LOAD_THRESHOLD;
        if (v == null || v === "") return DEFAULT_REPORT_LOAD_THRESHOLD;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? DEFAULT_REPORT_LOAD_THRESHOLD : n;
    }

    private recordTrace(requestId: string | undefined, step: string, startMs: number, durationMs: number, attributes?: Record<string, string | number | boolean>) {
        if (!requestId || !this.env.TRACE_DO) return;
        const event: TraceEvent = { requestId, step, startMs, durationMs, attributes };
        const stub = this.env.TRACE_DO.get(this.env.TRACE_DO.idFromName(TRACE_DO_SINGLETON_NAME));
        this.ctx.waitUntil(stub.recordEvent(event));
    }

    async reportLoad(requests: number, requestId?: string): Promise<void> {
        const startMs = 0;
        const t0 = Date.now();
        this.loadCounter += requests;
        const threshold = this.getReportLoadThreshold();
        if (this.loadCounter > threshold) {
            this.loadCounter = 0;
        }
        this.recordTrace(requestId, "partition_report_load", startMs, Date.now() - t0);
    }

    private getCacheKey(doKey: string): Request {
        return new Request(`https://shvm-db.local/partition/${this.ctx.id.toString()}/item/${encodeURIComponent(doKey)}`);
    }

    private async _getItemLocally(doKey: string, requestId?: string): Promise<any | null> {
        const cacheReq = this.getCacheKey(doKey);
        const tCache = Date.now();
        const cacheRes = await (caches as any).default.match(cacheReq);
        this.recordTrace(requestId, "partition_cache_read", 0, Date.now() - tCache, { hit: cacheRes ? true : false });

        if (cacheRes) {
            const data = await cacheRes.json() as any;
            if (data._deleted) return null;
            return data;
        }

        const tSql = Date.now();
        const cursor = this.sql.exec(PartitionDOQueries.Items.GET_LATEST, doKey);
        const row = Array.from(cursor)[0] as any;
        this.recordTrace(requestId, "partition_sql_read", 0, Date.now() - tSql);

        let result: any = null;
        if (!row || (row.deleted as number) === 1) {
            result = null;
        } else {
            result = JSON.parse(row.value as string);
        }

        const cacheData = result ? JSON.stringify(result) : JSON.stringify({ _deleted: true });
        const resToCache = new Response(cacheData, {
            headers: {
                "Cache-Control": "max-age=60"
            }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        return result;
    }

    async handleGetItem(doKey: string, requestId?: string, invokeTs?: number): Promise<any | null> {
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "partition_queue", 0, t0 - invokeTs);

        const item = await this._getItemLocally(doKey, requestId);

        this.recordTrace(requestId, "partition_get_item", 0, Date.now() - t0);
        return item;
    }

    async handlePutItem(doKey: string, value: unknown, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "partition_queue", 0, t0 - invokeTs);

        if (conditionExpression) {
            const currentItem = await this._getItemLocally(doKey, requestId);
            try {
                const pass = evaluateCondition(currentItem, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                const err = new Error(e.message);
                err.name = e.name === "ValidationError" ? "ValidationException" : "ConditionalCheckFailedException";
                throw err;
            }
        }

        const tSql = Date.now();
        this.sql.exec(PartitionDOQueries.Items.INSERT, doKey, 1, JSON.stringify(value), 0);
        this.recordTrace(requestId, "partition_sql_write", 0, Date.now() - tSql);

        const cacheReq = this.getCacheKey(doKey);
        const resToCache = new Response(JSON.stringify(value), {
            headers: { "Cache-Control": "max-age=60" }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        this.recordTrace(requestId, "partition_put_item", 0, Date.now() - t0);
        return {};
    }

    async handleDeleteItem(doKey: string, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "partition_queue", 0, t0 - invokeTs);

        let currentItem: any = null;
        if (conditionExpression || returnValues === "ALL_OLD") {
            currentItem = await this._getItemLocally(doKey, requestId);
        }

        if (conditionExpression) {
            try {
                const pass = evaluateCondition(currentItem, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                const err = new Error(e.message);
                err.name = e.name === "ValidationError" ? "ValidationException" : "ConditionalCheckFailedException";
                throw err;
            }
        }

        const tSql = Date.now();
        this.sql.exec(PartitionDOQueries.Items.INSERT, doKey, 1, null, 1);
        this.recordTrace(requestId, "partition_sql_write", 0, Date.now() - tSql);

        const cacheReq = this.getCacheKey(doKey);
        const resToCache = new Response(JSON.stringify({ _deleted: true }), {
            headers: { "Cache-Control": "max-age=60" }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        this.recordTrace(requestId, "partition_delete_item", 0, Date.now() - t0);
        if (returnValues === "ALL_OLD" && currentItem) return { Attributes: currentItem };
        return {};
    }

    async handleUpdateItem(doKey: string, updates: Record<string, AttributeValueUpdate>, partitionId: number, tableName: string, requestId?: string, updateExpression?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "partition_queue", 0, t0 - invokeTs);

        let currentItem: Record<string, any> = (await this._getItemLocally(doKey, requestId)) || {};

        if (conditionExpression) {
            try {
                const pass = evaluateCondition(Object.keys(currentItem).length > 0 ? currentItem : null, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                const err = new Error(e.message);
                err.name = e.name === "ValidationError" ? "ValidationException" : "ConditionalCheckFailedException";
                throw err;
            }
        }

        if (updateExpression) {
            evaluateUpdateExpression(currentItem, updateExpression, expressionAttributeNames, expressionAttributeValues);
        } else {
            for (const [key, update] of Object.entries(updates)) {
                const action = update.Action || 'PUT';
                if (action === 'PUT') currentItem[key] = update.Value;
                else if (action === 'DELETE') delete currentItem[key];
            }
        }

        const tSql = Date.now();
        this.sql.exec(PartitionDOQueries.Items.INSERT, doKey, 1, JSON.stringify(currentItem), 0);
        this.recordTrace(requestId, "partition_sql_write", 0, Date.now() - tSql);

        const cacheReq = this.getCacheKey(doKey);
        const resToCache = new Response(JSON.stringify(currentItem), {
            headers: { "Cache-Control": "max-age=60" }
        });
        this.ctx.waitUntil((caches as any).default.put(cacheReq, resToCache));

        this.recordTrace(requestId, "partition_update_item", 0, Date.now() - t0);

        if (returnValues === "ALL_NEW") return { Attributes: currentItem };
        return {};
    }
}
