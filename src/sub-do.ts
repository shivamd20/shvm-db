import { DurableObject } from "cloudflare:workers";
import { LRUCache, BloomFilter } from "./cache";
import { BLOOM_FILTER_SIZE, LRU_CACHE_CAPACITY } from "./constants";
import type { PartitionDO } from "./partition-do";
import type { TraceDO } from "./trace-do";
import { ReplicationMessage, Role, ReplicaState, AttributeValueUpdate } from "./types";
import { createDOLogger, Logger } from "./debug";
import { SubDOQueries } from "./sql/queries";
import type { TraceEvent } from "./trace-types";

const TRACE_DO_SINGLETON_NAME = "shvm-db-trace";
const SUB_DO_FLUSH_DELAY_MS = 50;
/** SQLite max bind params is 999; 4 params per row -> chunk at 200 */
const SUB_DO_INSERT_CHUNK_SIZE = 200;

interface PendingWrite {
    sk: string;
    value: unknown;
    deleted: number;
    partitionId: number;
    tableName: string;
    requestId?: string;
}

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
    TRACE_DO?: DurableObjectNamespace<TraceDO>;
    REPLICATION_QUEUE: Queue;
    SHVM_DEBUG?: string;
    [key: string]: any;
}

export class SubDO extends DurableObject<Env> {
    sql: SqlStorage;
    lru: LRUCache<string, unknown>;
    bf: BloomFilter;
    state: DurableObjectState;
    private log: Logger;

    // Runtime State
    role: Role = Role.REPLICA; // Default safe
    replicaState: ReplicaState = ReplicaState.CREATED;
    lastAppliedVersion: number = 0;
    migrationTargetVersion: number = 0;

    /** Pending writes (write-through buffer). Flushed by alarm. */
    private pendingWrites: PendingWrite[] = [];

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.state = ctx;
        this.sql = ctx.storage.sql;
        this.lru = new LRUCache(LRU_CACHE_CAPACITY);
        this.bf = new BloomFilter(BLOOM_FILTER_SIZE);
        this.log = createDOLogger(env.SHVM_DEBUG);

        this.initializeStorage();
        this.loadState();
    }

    private initializeStorage() {
        this.sql.exec(SubDOQueries.Schema.CREATE_METADATA);
        this.sql.exec(SubDOQueries.Schema.CREATE_ITEMS);
        this.sql.exec(SubDOQueries.Schema.CREATE_CURSORS);
    }

    private loadState() {
        const roleCursor = this.sql.exec(SubDOQueries.Metadata.GET, "role");
        const roleRow = Array.from(roleCursor)[0] as any;
        if (roleRow) this.role = roleRow.value as Role;
        const cursorIter = this.sql.exec(SubDOQueries.Cursors.GET, "lastApplied");
        const cursorRow = Array.from(cursorIter)[0] as any;
        if (cursorRow) this.lastAppliedVersion = cursorRow.val as number;
        const stateIter = this.sql.exec(SubDOQueries.Metadata.GET, "replicaState");
        const stateRow = Array.from(stateIter)[0] as any;
        if (stateRow) this.replicaState = stateRow.value as ReplicaState;
    }

    private recordTrace(requestId: string | undefined, step: string, startMs: number, durationMs: number, attributes?: Record<string, string | number | boolean>) {
        if (!requestId || !this.env.TRACE_DO) return;
        const event: TraceEvent = { requestId, step, startMs, durationMs, attributes };
        const stub = this.env.TRACE_DO.get(this.env.TRACE_DO.idFromName(TRACE_DO_SINGLETON_NAME));
        this.ctx.waitUntil(stub.recordEvent(event));
    }

    async init(role: Role) {
        if (this.role !== role) {
            this.log("SubDO", `init: role change ${this.role} -> ${role} (id=${this.state.id.toString()})`);
            this.role = role;
            this.sql.exec(SubDOQueries.Metadata.SET, "role", role);

            if (role === Role.LEADER || role === Role.STANDBY) {
                this.setReplicaState(ReplicaState.READABLE);
            }
        }
    }

    private setReplicaState(newState: ReplicaState) {
        this.log("SubDO", `state transition: ${this.replicaState} -> ${newState} (id=${this.state.id.toString()})`);
        this.replicaState = newState;
        this.sql.exec(SubDOQueries.Metadata.SET, "replicaState", newState);
    }

    private persistCursor(v: number) {
        this.lastAppliedVersion = v;
        this.sql.exec(SubDOQueries.Cursors.SET, "lastApplied", v);
    }

    /** Returns latest value for sk from pending (by insertion order). undefined = not in pending; null = deleted. */
    private getLatestPending(sk: string): unknown | undefined {
        for (let i = this.pendingWrites.length - 1; i >= 0; i--) {
            if (this.pendingWrites[i].sk === sk) {
                return this.pendingWrites[i].deleted === 1 ? null : this.pendingWrites[i].value;
            }
        }
        return undefined;
    }

    private scheduleFlushAlarm(): void {
        this.ctx.storage.setAlarm(Date.now() + SUB_DO_FLUSH_DELAY_MS);
    }

    async alarm(): Promise<void> {
        const snapshot = this.pendingWrites;
        this.pendingWrites = [];
        if (snapshot.length === 0) return;

        this.sql.exec(SubDOQueries.Cursors.INIT_SEQ);
        const seqCursor = this.sql.exec(SubDOQueries.Cursors.GET_SEQ);
        const seqRow = Array.from(seqCursor)[0] as any;
        const V = (seqRow?.val as number) ?? 0;

        const n = snapshot.length;
        for (let off = 0; off < n; off += SUB_DO_INSERT_CHUNK_SIZE) {
            const chunk = snapshot.slice(off, off + SUB_DO_INSERT_CHUNK_SIZE);
            const valuePlaceholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
            const batchInsertSql = `INSERT INTO items_v2 (sk, version, value, deleted) VALUES ${valuePlaceholders}`;
            const params: (string | number | null)[] = [];
            for (let i = 0; i < chunk.length; i++) {
                const e = chunk[i];
                params.push(e.sk, V + 1 + off + i, e.deleted === 0 ? JSON.stringify(e.value) : null, e.deleted);
            }
            this.sql.exec(batchInsertSql, ...params);
        }
        this.sql.exec(SubDOQueries.Cursors.INC_SEQ_BY_N, n);
        this.sql.exec(SubDOQueries.Cursors.SET, "lastApplied", V + n);
        this.lastAppliedVersion = V + n;

        await Promise.all(snapshot.map((e, i) => {
            const version = V + 1 + i;
            if (e.deleted === 1) {
                return this.env.REPLICATION_QUEUE.send({
                    type: 'DELETE', sk: e.sk, version, partitionId: e.partitionId, tableName: e.tableName, replicationFactor: 0,
                    enqueuedTs: Date.now(), requestId: e.requestId
                });
            }
            return this.env.REPLICATION_QUEUE.send({
                type: 'PUT', sk: e.sk, value: e.value, version, partitionId: e.partitionId, tableName: e.tableName, replicationFactor: 0,
                enqueuedTs: Date.now(), requestId: e.requestId
            });
        }));

        if (this.pendingWrites.length > 0) this.scheduleFlushAlarm();
    }

    async ensureLeaderAndPutItem(sk: string, value: unknown, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        await this.init(Role.LEADER);
        return this.putItem(sk, value, partitionId, tableName, requestId, conditionExpression, expressionAttributeNames, expressionAttributeValues, returnValues, invokeTs);
    }

    async ensureLeaderAndDeleteItem(sk: string, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        await this.init(Role.LEADER);
        return this.deleteItem(sk, partitionId, tableName, requestId, conditionExpression, expressionAttributeNames, expressionAttributeValues, returnValues, invokeTs);
    }

    async ensureLeaderAndUpdateItem(sk: string, updates: Record<string, AttributeValueUpdate>, partitionId: number, tableName: string, requestId?: string, updateExpression?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        await this.init(Role.LEADER);
        return this.updateItem(sk, updates, partitionId, tableName, requestId, updateExpression, conditionExpression, expressionAttributeNames, expressionAttributeValues, returnValues, invokeTs);
    }

    private checkCondition(item: any, conditionExpression?: string, names?: Record<string, string>, values?: Record<string, any>): boolean {
        if (!conditionExpression) return true;

        let expr = conditionExpression.trim();

        // Very basic parsing for attribute_not_exists and exact match (x = :v)
        const notExistsMatch = expr.match(/attribute_not_exists\(([^)]+)\)/);
        if (notExistsMatch) {
            const attr = notExistsMatch[1].trim();
            const realAttr = names?.[attr] || attr;
            // Reserved keyword check (if no mapping provided)
            if (!names?.[attr] && ['exists', 'name', 'status'].includes(realAttr.toLowerCase())) {
                throw new Error(`Invalid ConditionExpression: Attribute name is a reserved keyword; reserved keyword: ${realAttr}`);
            }
            if (item && item[realAttr] !== undefined) return false;
            return true; // it does not exist
        }

        const eqMatch = expr.match(/([^=]+)\s*=\s*(:\w+)/);
        if (eqMatch) {
            const attr = eqMatch[1].trim();
            const valKey = eqMatch[2].trim();
            const realAttr = names?.[attr] || attr;
            const expectedVal = values?.[valKey];
            const currentVal = item ? item[realAttr] : undefined;

            if (JSON.stringify(currentVal) !== JSON.stringify(expectedVal)) return false;
            return true;
        }

        return true; // default true if unknown expression for now
    }

    // --- LEADER ONLY ---

    async putItem(sk: string, value: unknown, partitionId: number, tableName: string = 'default', requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);
        if (this.role !== Role.LEADER) throw new Error(`Not Leader: I am ${this.role}`);

        // Evaluate condition
        if (conditionExpression) {
            const currentItem = await this.getItem(sk, requestId) as any;
            try {
                const pass = this.checkCondition(currentItem, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                if (e.message.includes("reserved keyword")) {
                    const err = new Error(e.message);
                    err.name = "ValidationException";
                    throw err;
                }
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
            }
        }

        this.log("SubDO", `[LEADER] putItem sk=${sk} partition=${partitionId} table=${tableName} (pending)`);
        this.pendingWrites.push({ sk, value, deleted: 0, partitionId, tableName, requestId });
        this.lru.put(sk, value);
        this.bf.add(sk);
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm == null) this.scheduleFlushAlarm();
        this.recordTrace(requestId, "subdo_put_item", startMs, Date.now() - t0);
        return {}; // ReturnValues ALL_OLD not supported for PutItem in DynamoDB usually, only NONE
    }

    async deleteItem(sk: string, partitionId: number, tableName: string = 'default', requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);
        if (this.role !== Role.LEADER) throw new Error(`Not Leader: I am ${this.role}`);

        let currentItem: any = null;
        if (conditionExpression || returnValues === "ALL_OLD") {
            currentItem = await this.getItem(sk, requestId) as any;
        }

        // Evaluate condition
        if (conditionExpression) {
            try {
                const pass = this.checkCondition(currentItem, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                if (e.message.includes("reserved keyword")) {
                    const err = new Error(e.message);
                    err.name = "ValidationException";
                    throw err;
                }
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
            }
        }

        this.log("SubDO", `[LEADER] deleteItem sk=${sk} partition=${partitionId} table=${tableName} (pending)`);
        this.pendingWrites.push({ sk, value: null, deleted: 1, partitionId, tableName, requestId });
        this.lru.remove(sk);
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm == null) this.scheduleFlushAlarm();
        this.recordTrace(requestId, "subdo_delete_item", startMs, Date.now() - t0);

        if (returnValues === "ALL_OLD" && currentItem) return { Attributes: currentItem };
        return {};
    }

    async updateItem(sk: string, updates: Record<string, AttributeValueUpdate>, partitionId: number, tableName: string = 'default', requestId?: string, updateExpression?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);
        if (this.role !== Role.LEADER) throw new Error(`Not Leader: I am ${this.role}`);

        let currentItem: Record<string, any> = (await this.getItem(sk, requestId) as any) || {};

        // Evaluate condition
        if (conditionExpression) {
            try {
                const pass = this.checkCondition(Object.keys(currentItem).length > 0 ? currentItem : null, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                if (e.message.includes("reserved keyword")) {
                    const err = new Error(e.message);
                    err.name = "ValidationException";
                    throw err;
                }
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
            }
        }

        if (updateExpression) {
            // Very basic parse of 'SET a = :v REMOVE b'
            const setMatch = updateExpression.match(/SET\s+([^R]+)/);
            if (setMatch) {
                const parts = setMatch[1].split(',');
                for (const p of parts) {
                    const [attr, valVar] = p.split('=').map(s => s.trim());
                    const realAttr = expressionAttributeNames?.[attr] || attr;
                    if (expressionAttributeValues && expressionAttributeValues[valVar]) {
                        currentItem[realAttr] = expressionAttributeValues[valVar];
                    }
                }
            }

            const removeMatch = updateExpression.match(/REMOVE\s+(.+)/);
            if (removeMatch) {
                const parts = removeMatch[1].split(',');
                for (let attr of parts) {
                    attr = attr.trim();
                    const realAttr = expressionAttributeNames?.[attr] || attr;
                    delete currentItem[realAttr];
                }
            }
        } else {
            for (const [key, update] of Object.entries(updates)) {
                const action = update.Action || 'PUT';
                if (action === 'PUT') currentItem[key] = update.Value;
                else if (action === 'DELETE') delete currentItem[key];
            }
        }

        this.log("SubDO", `[LEADER] updateItem sk=${sk} partition=${partitionId} table=${tableName} (pending)`);
        this.pendingWrites.push({ sk, value: currentItem, deleted: 0, partitionId, tableName, requestId });
        this.lru.put(sk, currentItem);
        this.bf.add(sk);
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm == null) this.scheduleFlushAlarm();
        this.recordTrace(requestId, "subdo_update_item", startMs, Date.now() - t0);

        if (returnValues === "ALL_NEW") return { Attributes: currentItem };
        return {};
    }

    async ensureLeaderAndGetItem(sk: string, requestId?: string, invokeTs?: number): Promise<unknown | null> {
        await this.init(Role.LEADER);
        return this.getItem(sk, requestId, invokeTs);
    }

    // --- COMMON APPLY ---

    applyMutation(msg: ReplicationMessage) {
        if (msg.version <= this.lastAppliedVersion) {
            this.log("SubDO", `applyMutation SKIP (idempotent) version=${msg.version} lastApplied=${this.lastAppliedVersion}`);
            return;
        }
        this.log("SubDO", `applyMutation type=${msg.type} sk=${msg.sk} v=${msg.version} role=${this.role} state=${this.replicaState}`);
        if (msg.type === 'PUT') this.applyToLocal(msg.sk, msg.version, msg.value, 0);
        else if (msg.type === 'DELETE') this.applyToLocal(msg.sk, msg.version, null, 1);
        this.persistCursor(msg.version);
        if (this.role === Role.REPLICA && this.replicaState === ReplicaState.CATCHING_UP && this.lastAppliedVersion >= this.migrationTargetVersion) {
            this.log("SubDO", `Promoting to READABLE (caught up to version ${this.migrationTargetVersion})`);
            this.promoteToReadable();
        }
    }

    private applyToLocal(sk: string, version: number, value: any, deleted: number) {
        this.sql.exec(SubDOQueries.Items.INSERT, sk, version, deleted === 0 ? JSON.stringify(value) : null, deleted);

        if (deleted === 0) {
            this.lru.put(sk, value);
            this.bf.add(sk);
        } else {
            this.lru.remove(sk);
        }
    }

    // --- STANDBY ONLY ---

    // Called by Control Plane/Autoscaler
    async provisionReplica(replicaId: string, targetVersion?: number) {
        if (this.role !== Role.STANDBY) throw new Error("Only Standby can provision");

        const boundary = targetVersion || this.lastAppliedVersion;
        this.log("SubDO", `[STANDBY] provisionReplica id=${replicaId} boundary=${boundary} lastApplied=${this.lastAppliedVersion}`);

        // Send Backfill Command
        const stub = this.env.SUB_DO.get(this.env.SUB_DO.idFromName(replicaId));
        // We call 'init' first to ensure it knows it is a REPLICA
        await stub.init(Role.REPLICA);
        await stub.startBackfill(boundary);
    }

    // Generator for History
    async streamHistory(sinceVersion: number = 0, untilVersion: number): Promise<ReplicationMessage[]> {
        // Return full history as one batch for simplicity (or paginate if needed)
        // Cloudflare RPC supports streaming via ReadableStream, but let's stick to array for simplicity
        const cursor = this.sql.exec(SubDOQueries.Items.GET_HISTORY, sinceVersion, untilVersion);

        const rows = Array.from(cursor) as any[];

        return rows.map(r => ({
            type: (r.deleted as number) === 1 ? 'DELETE' as const : 'PUT' as const,
            sk: r.sk as string,
            value: r.value ? JSON.parse(r.value as string) : undefined,
            version: r.version as number,
            partitionId: 0,
            tableName: '',
            replicationFactor: 0
        }));
    }

    // --- REPLICA ONLY ---

    async startBackfill(targetVersion: number) {
        if (this.role !== Role.REPLICA) throw new Error("Only Replica can backfill");
        this.log("SubDO", `[REPLICA] startBackfill targetVersion=${targetVersion}`);
        this.setReplicaState(ReplicaState.BACKFILLING);
        this.migrationTargetVersion = targetVersion;

        const standbyRef = this.sql.exec(SubDOQueries.Metadata.GET, "standbyRef");
        const standbyRow = Array.from(standbyRef)[0] as any;
        const standbyId = standbyRow?.value || "partition-0-standby";
        this.log("SubDO", `[REPLICA] pulling history from standby=${standbyId}`);
        const standbyStub = this.env.SUB_DO.get(this.env.SUB_DO.idFromName(standbyId)) as DurableObjectStub<SubDO>;

        const history: ReplicationMessage[] = await standbyStub.streamHistory(0, targetVersion);
        this.log("SubDO", `[REPLICA] received ${history.length} history messages`);

        for (const msg of history) {
            this.applyMutation(msg);
        }

        this.setReplicaState(ReplicaState.CATCHING_UP);
        if (this.lastAppliedVersion >= this.migrationTargetVersion) {
            this.promoteToReadable();
        }
    }

    private async promoteToReadable() {
        this.setReplicaState(ReplicaState.READABLE);
        // Register with PartitionDO
        const pId = 0; // Derived
        const pStub = this.env.PARTITION_DO.get(this.env.PARTITION_DO.idFromName(`partition-${pId}`));
        // We need our own ID as string. 
        // We can't get it easily.
        // Let's assume the caller who created us (Standby) registers us?
        // Or we pass our ID during init?
        // Let's rely on 'init' passing ID or assume convention.
        // Actually, 'this.state.id.toString()' handles distinct ID string.
        await pStub.registerReplica(this.state.id.toString());
    }

    // --- READ ---

    async getItem(sk: string, requestId?: string, invokeTs?: number): Promise<unknown | null> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);
        this.log("SubDO", `getItem sk=${sk} role=${this.role} state=${this.replicaState}`);
        if (this.replicaState !== ReplicaState.READABLE && this.role !== Role.LEADER && this.role !== Role.STANDBY) {
            throw new Error(`Replica not readable yet. State: ${this.replicaState}`);
        }
        const fromPending = this.getLatestPending(sk);
        if (fromPending !== undefined) {
            this.log("SubDO", `getItem PENDING sk=${sk}`);
            this.recordTrace(requestId, "subdo_get_item", startMs, Date.now() - t0, { subdo_source: "pending" });
            return fromPending;
        }
        const tLru = Date.now();
        const cached = this.lru.get(sk);
        this.recordTrace(requestId, "subdo_lru_get", 0, Date.now() - tLru);
        if (cached !== undefined) {
            this.log("SubDO", `getItem CACHE HIT sk=${sk}`);
            this.recordTrace(requestId, "subdo_get_item", startMs, Date.now() - t0, { subdo_source: "lru_hit" });
            return cached;
        }
        const tBf = Date.now();
        const hasSk = this.bf.has(sk);
        this.recordTrace(requestId, "subdo_bf_has", 0, Date.now() - tBf);
        if (!hasSk) {
            this.log("SubDO", `getItem BLOOM NEGATIVE sk=${sk}`);
            this.recordTrace(requestId, "subdo_get_item", startMs, Date.now() - t0, { subdo_source: "bloom_negative" });
            return null;
        }
        const tSql = Date.now();
        const cursor = this.sql.exec(SubDOQueries.Items.GET_LATEST, sk);
        const row = Array.from(cursor)[0] as any;
        this.recordTrace(requestId, "subdo_sql_read", 0, Date.now() - tSql);
        if (!row || (row.deleted as number) === 1) {
            this.log("SubDO", `getItem NOT FOUND sk=${sk}`);
            this.recordTrace(requestId, "subdo_get_item", startMs, Date.now() - t0, { subdo_source: "sql_miss" });
            return null;
        }
        const val = JSON.parse(row.value as string);
        this.lru.put(sk, val);
        this.log("SubDO", `getItem FOUND sk=${sk}`);
        this.recordTrace(requestId, "subdo_get_item", startMs, Date.now() - t0, { subdo_source: "sql" });
        return val;
    }

    /** Returns internal debug state for testing/observability */
    async getDebugState(): Promise<{ role: string; replicaState: string; lastAppliedVersion: number }> {
        return {
            role: this.role,
            replicaState: this.replicaState,
            lastAppliedVersion: this.lastAppliedVersion
        };
    }
}
