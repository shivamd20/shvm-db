import { DurableObject } from "cloudflare:workers";
import { SubDO } from "./sub-do";
import type { TraceDO } from "./trace-do";
import { RoutingTable, ReplicaState, Role } from "./types";
import { createDOLogger, Logger } from "./debug";
import { PartitionDOQueries } from "./sql/queries";
import type { TraceEvent } from "./trace-types";

const TRACE_DO_SINGLETON_NAME = "shvm-db-trace";
const DEFAULT_REPORT_LOAD_THRESHOLD = 10;

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
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
        this.sql.exec(PartitionDOQueries.Schema.CREATE_REPLICAS);
        this.log("PartitionDO", `constructor id=${ctx.id.toString()}`);
    }

    private getReportLoadThreshold(): number {
        const v = this.env.REPORT_LOAD_THRESHOLD;
        if (v == null || v === "") return DEFAULT_REPORT_LOAD_THRESHOLD;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? DEFAULT_REPORT_LOAD_THRESHOLD : n;
    }

    private recordTrace(requestId: string | undefined, step: string, startMs: number, durationMs: number) {
        if (!requestId || !this.env.TRACE_DO) return;
        const event: TraceEvent = { requestId, step, startMs, durationMs };
        const stub = this.env.TRACE_DO.get(this.env.TRACE_DO.idFromName(TRACE_DO_SINGLETON_NAME));
        this.ctx.waitUntil(stub.recordEvent(event));
    }

    async registerReplica(replicaId: string): Promise<void> {
        this.log("PartitionDO", `registerReplica id=${replicaId}`);
        this.sql.exec(PartitionDOQueries.Replicas.REGISTER, replicaId, ReplicaState.READABLE, Date.now());
    }

    async deregisterReplica(replicaId: string): Promise<void> {
        this.log("PartitionDO", `deregisterReplica id=${replicaId}`);
        this.sql.exec(PartitionDOQueries.Replicas.DEREGISTER, replicaId);
    }

    async getRoutingConfig(requestId?: string): Promise<RoutingTable> {
        const startMs = 0;
        const t0 = Date.now();
        const cursor = this.sql.exec(PartitionDOQueries.Replicas.GET_READABLE, ReplicaState.READABLE);
        const rows = Array.from(cursor);
        const replicaIds = rows.map((r: any) => r.id as string);
        this.log("PartitionDO", `getRoutingConfig: ${replicaIds.length} readable replicas`);
        this.recordTrace(requestId, "partition_get_routing", startMs, Date.now() - t0);
        return {
            version: Date.now(),
            partitions: 100,
            replicas: { 0: replicaIds }
        };
    }

    async reportLoad(requests: number, requestId?: string): Promise<void> {
        const startMs = 0;
        const t0 = Date.now();
        this.loadCounter += requests;
        this.log("PartitionDO", `reportLoad: counter=${this.loadCounter}`);
        const threshold = this.getReportLoadThreshold();
        if (this.loadCounter > threshold) {
            this.loadCounter = 0;
            await this.checkScaling();
        }
        this.recordTrace(requestId, "partition_report_load", startMs, Date.now() - t0);
    }

    async checkScaling() {
        const cursor = this.sql.exec(PartitionDOQueries.Replicas.COUNT_READABLE, ReplicaState.READABLE);
        const count = (Array.from(cursor)[0] as any).count as number;
        this.log("PartitionDO", `checkScaling: readable_replicas=${count}`);
        if (count < 1) {
            const newReplicaId = `partition-0-r${Date.now()}`;
            this.log("PartitionDO", `checkScaling: provisioning new replica ${newReplicaId}`);
            const standbyStub = this.env.SUB_DO.get(this.env.SUB_DO.idFromName("partition-0-standby"));
            await standbyStub.init(Role.STANDBY);
            await standbyStub.provisionReplica(newReplicaId);
        }
    }

    /** List all replicas for observability */
    async listReplicas(): Promise<{ id: string; state: string; lastSeen: number }[]> {
        const cursor = this.sql.exec(PartitionDOQueries.Replicas.LIST_ALL);
        const rows = Array.from(cursor) as any[];
        return rows.map(r => ({ id: r.id, state: r.state, lastSeen: r.last_seen }));
    }
}
