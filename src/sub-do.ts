import { DurableObject } from "cloudflare:workers";

import type { PartitionDO } from "./partition-do";
import type { TraceDO } from "./trace-do";
import { ReplicationMessage, Role, ReplicaState, AttributeValueUpdate } from "./types";
import { createDOLogger, Logger } from "./debug";
import { SubDOQueries } from "./sql/queries";
import { runSubDOMigrations } from "./sql/migrations";
import type { TraceEvent } from "./trace-types";
import { evaluateCondition, evaluateUpdateExpression } from "./dynamo-ast";

const TRACE_DO_SINGLETON_NAME = "shvm-db-trace";

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
    TRACE_DO?: DurableObjectNamespace<TraceDO>;
    REPLICATION_QUEUE: Queue;
    SHVM_DEBUG?: string;
    [key: string]: any;
}

abstract class SubDORole {
    protected do: SubDO;
    constructor(durableObject: SubDO) {
        this.do = durableObject;
    }

    async putItem(sk: string, value: unknown, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        throw new Error(`Not Leader: I am ${this.do.role}`);
    }

    async deleteItem(sk: string, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        throw new Error(`Not Leader: I am ${this.do.role}`);
    }

    async updateItem(sk: string, updates: Record<string, AttributeValueUpdate>, partitionId: number, tableName: string, requestId?: string, updateExpression?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        throw new Error(`Not Leader: I am ${this.do.role}`);
    }

    async provisionReplica(replicaId: string, targetVersion?: number) {
        throw new Error("Only Standby can provision");
    }

    async startBackfill(targetVersion: number) {
        throw new Error("Only Replica can backfill");
    }
}

class LeaderSubDO extends SubDORole {
    async putItem(sk: string, value: unknown, partitionId: number, tableName: string = 'default', requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.do.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);

        if (conditionExpression) {
            const currentItem = await this.do.getItem(sk, requestId) as any;
            try {
                const pass = evaluateCondition(currentItem, conditionExpression, expressionAttributeNames, expressionAttributeValues);
                if (!pass) throw new Error("The conditional request failed");
            } catch (e: any) {
                const err = new Error(e.message);
                err.name = e.name === "ValidationError" ? "ValidationException" : "ConditionalCheckFailedException";
                throw err;
            }
        }

        this.do.log("SubDO", `[LEADER] putItem sk=${sk} partition=${partitionId} table=${tableName}`);
        await this.do.applyAndReplicateWrite({ sk, value, deleted: 0, partitionId, tableName, requestId });
        this.do.recordTrace(requestId, "subdo_put_item", startMs, Date.now() - t0);
        return {};
    }

    async deleteItem(sk: string, partitionId: number, tableName: string = 'default', requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.do.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);

        let currentItem: any = null;
        if (conditionExpression || returnValues === "ALL_OLD") {
            currentItem = await this.do.getItem(sk, requestId) as any;
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

        this.do.log("SubDO", `[LEADER] deleteItem sk=${sk} partition=${partitionId} table=${tableName}`);
        await this.do.applyAndReplicateWrite({ sk, value: null, deleted: 1, partitionId, tableName, requestId });
        this.do.recordTrace(requestId, "subdo_delete_item", startMs, Date.now() - t0);

        if (returnValues === "ALL_OLD" && currentItem) return { Attributes: currentItem };
        return {};
    }

    async updateItem(sk: string, updates: Record<string, AttributeValueUpdate>, partitionId: number, tableName: string = 'default', requestId?: string, updateExpression?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.do.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);

        let currentItem: Record<string, any> = (await this.do.getItem(sk, requestId) as any) || {};

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

        this.do.log("SubDO", `[LEADER] updateItem sk=${sk} partition=${partitionId} table=${tableName}`);
        await this.do.applyAndReplicateWrite({ sk, value: currentItem, deleted: 0, partitionId, tableName, requestId });
        this.do.recordTrace(requestId, "subdo_update_item", startMs, Date.now() - t0);

        if (returnValues === "ALL_NEW") return { Attributes: currentItem };
        return {};
    }
}

class ReplicaSubDO extends SubDORole {
    async startBackfill(targetVersion: number) {
        this.do.log("SubDO", `[REPLICA] startBackfill targetVersion=${targetVersion}`);
        this.do.setReplicaState(ReplicaState.BACKFILLING);
        this.do.migrationTargetVersion = targetVersion;

        const standbyRef = this.do.sql.exec(SubDOQueries.Metadata.GET, "standbyRef");
        const standbyRow = Array.from(standbyRef)[0] as any;
        const standbyId = standbyRow?.value || "partition-0-standby";
        this.do.log("SubDO", `[REPLICA] pulling history from standby=${standbyId}`);
        const env = this.do.getEnv();
        const standbyStub = env.SUB_DO.get(env.SUB_DO.idFromName(standbyId)) as DurableObjectStub<SubDO>;

        const history: ReplicationMessage[] = await standbyStub.streamHistory(0, targetVersion);
        this.do.log("SubDO", `[REPLICA] received ${history.length} history messages`);

        for (const msg of history) {
            this.do.applyMutation(msg);
        }

        this.do.setReplicaState(ReplicaState.CATCHING_UP);
        if (this.do.lastAppliedVersion >= this.do.migrationTargetVersion) {
            this.do.promoteToReadable();
        }
    }
}

class StandbySubDO extends SubDORole {
    async provisionReplica(replicaId: string, targetVersion?: number) {
        const boundary = targetVersion || this.do.lastAppliedVersion;
        this.do.log("SubDO", `[STANDBY] provisionReplica id=${replicaId} boundary=${boundary} lastApplied=${this.do.lastAppliedVersion}`);

        const env = this.do.getEnv();
        const stub = env.SUB_DO.get(env.SUB_DO.idFromName(replicaId));
        await stub.init(Role.REPLICA);
        await stub.startBackfill(boundary);
    }
}

export class SubDO extends DurableObject<Env> {
    sql: SqlStorage;

    state: DurableObjectState;
    public log: Logger;

    // Runtime State
    role: Role = Role.REPLICA;
    replicaState: ReplicaState = ReplicaState.CREATED;
    lastAppliedVersion: number = 0;
    migrationTargetVersion: number = 0;

    private handler: SubDORole;

    public getEnv(): Env {
        return this.env;
    }

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.state = ctx;
        this.sql = ctx.storage.sql;

        this.log = createDOLogger(env.SHVM_DEBUG);
        this.handler = new ReplicaSubDO(this);

        this.runMigrations();
        this.loadState();
    }

    private runMigrations() {
        runSubDOMigrations(this.sql);
    }

    private loadState() {
        const roleCursor = this.sql.exec(SubDOQueries.Metadata.GET, "role");
        const roleRow = Array.from(roleCursor)[0] as any;
        if (roleRow) {
            this.role = roleRow.value as Role;
        }
        const cursorIter = this.sql.exec(SubDOQueries.Cursors.GET, "lastApplied");
        const cursorRow = Array.from(cursorIter)[0] as any;
        if (cursorRow) this.lastAppliedVersion = cursorRow.val as number;
        const stateIter = this.sql.exec(SubDOQueries.Metadata.GET, "replicaState");
        const stateRow = Array.from(stateIter)[0] as any;
        if (stateRow) this.replicaState = stateRow.value as ReplicaState;

        this.updateHandler();
    }

    private updateHandler() {
        if (this.role === Role.LEADER) this.handler = new LeaderSubDO(this);
        else if (this.role === Role.STANDBY) this.handler = new StandbySubDO(this);
        else this.handler = new ReplicaSubDO(this);
    }

    recordTrace(requestId: string | undefined, step: string, startMs: number, durationMs: number, attributes?: Record<string, string | number | boolean>) {
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
            this.updateHandler();

            if (role === Role.LEADER || role === Role.STANDBY) {
                this.setReplicaState(ReplicaState.READABLE);
            }
        }
    }

    public setReplicaState(newState: ReplicaState) {
        this.log("SubDO", `state transition: ${this.replicaState} -> ${newState} (id=${this.state.id.toString()})`);
        this.replicaState = newState;
        this.sql.exec(SubDOQueries.Metadata.SET, "replicaState", newState);
    }

    private persistCursor(v: number) {
        this.lastAppliedVersion = v;
        this.sql.exec(SubDOQueries.Cursors.SET, "lastApplied", v);
    }

    async applyAndReplicateWrite(e: { sk: string, value: unknown, deleted: number, partitionId: number, tableName: string, requestId?: string }) {
        this.sql.exec(SubDOQueries.Cursors.INIT_SEQ);
        const seqCursor = this.sql.exec(SubDOQueries.Cursors.GET_SEQ);
        const seqRow = Array.from(seqCursor)[0] as any;
        const V = (seqRow?.val as number) ?? 0;
        const nextV = V + 1;

        this.sql.exec(SubDOQueries.Items.INSERT, e.sk, nextV, e.deleted === 0 ? JSON.stringify(e.value) : null, e.deleted);
        this.sql.exec(SubDOQueries.Cursors.INC_SEQ_BY_N, 1);
        this.sql.exec(SubDOQueries.Cursors.SET, "lastApplied", nextV);
        this.lastAppliedVersion = nextV;

        if (e.deleted === 1) {
            this.ctx.waitUntil(this.env.REPLICATION_QUEUE.send({
                type: 'DELETE', sk: e.sk, version: nextV, partitionId: e.partitionId, tableName: e.tableName, replicationFactor: 0,
                enqueuedTs: Date.now(), requestId: e.requestId
            }));
        } else {
            this.ctx.waitUntil(this.env.REPLICATION_QUEUE.send({
                type: 'PUT', sk: e.sk, value: e.value, version: nextV, partitionId: e.partitionId, tableName: e.tableName, replicationFactor: 0,
                enqueuedTs: Date.now(), requestId: e.requestId
            }));
        }
    }

    async ensureLeaderAndPutItem(sk: string, value: unknown, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        await this.init(Role.LEADER);
        return this.handler.putItem(sk, value, partitionId, tableName, requestId, conditionExpression, expressionAttributeNames, expressionAttributeValues, returnValues, invokeTs);
    }

    async ensureLeaderAndDeleteItem(sk: string, partitionId: number, tableName: string, requestId?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        await this.init(Role.LEADER);
        return this.handler.deleteItem(sk, partitionId, tableName, requestId, conditionExpression, expressionAttributeNames, expressionAttributeValues, returnValues, invokeTs);
    }

    async ensureLeaderAndUpdateItem(sk: string, updates: Record<string, AttributeValueUpdate>, partitionId: number, tableName: string, requestId?: string, updateExpression?: string, conditionExpression?: string, expressionAttributeNames?: Record<string, string>, expressionAttributeValues?: Record<string, any>, returnValues?: string, invokeTs?: number): Promise<any> {
        await this.init(Role.LEADER);
        return this.handler.updateItem(sk, updates, partitionId, tableName, requestId, updateExpression, conditionExpression, expressionAttributeNames, expressionAttributeValues, returnValues, invokeTs);
    }

    async ensureLeaderAndGetItem(sk: string, requestId?: string, invokeTs?: number): Promise<unknown | null> {
        await this.init(Role.LEADER);
        return this.getItem(sk, requestId, invokeTs);
    }

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
    }

    async provisionReplica(replicaId: string, targetVersion?: number) {
        return this.handler.provisionReplica(replicaId, targetVersion);
    }

    async streamHistory(sinceVersion: number = 0, untilVersion: number): Promise<ReplicationMessage[]> {
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

    async startBackfill(targetVersion: number) {
        return this.handler.startBackfill(targetVersion);
    }

    public async promoteToReadable() {
        this.setReplicaState(ReplicaState.READABLE);
        const pId = 0; // Derived
        const pStub = this.env.PARTITION_DO.get(this.env.PARTITION_DO.idFromName(`partition-${pId}`));
        await pStub.registerReplica(this.state.id.toString());
    }

    async getItem(sk: string, requestId?: string, invokeTs?: number): Promise<unknown | null> {
        const startMs = 0;
        const t0 = Date.now();
        if (invokeTs) this.recordTrace(requestId, "subdo_queue", 0, t0 - invokeTs);
        this.log("SubDO", `getItem sk=${sk} role=${this.role} state=${this.replicaState}`);
        if (this.replicaState !== ReplicaState.READABLE && this.role !== Role.LEADER && this.role !== Role.STANDBY) {
            throw new Error(`Replica not readable yet. State: ${this.replicaState}`);
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
        this.log("SubDO", `getItem FOUND sk=${sk}`);
        this.recordTrace(requestId, "subdo_get_item", startMs, Date.now() - t0, { subdo_source: "sql" });
        return val;
    }

    async getDebugState(): Promise<{ role: string; replicaState: string; lastAppliedVersion: number }> {
        return {
            role: this.role,
            replicaState: this.replicaState,
            lastAppliedVersion: this.lastAppliedVersion
        };
    }
}
