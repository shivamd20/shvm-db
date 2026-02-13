
import { DurableObject } from "cloudflare:workers";
import { SubDO } from "./sub-do";
import { RoutingTable, ReplicaState, Role } from "./types";
import { createDOLogger, Logger } from "./debug";
import { PartitionDOQueries } from "./sql/queries";

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
    SHVM_DEBUG?: string;
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

    async registerReplica(replicaId: string): Promise<void> {
        this.log("PartitionDO", `registerReplica id=${replicaId}`);
        this.sql.exec(PartitionDOQueries.Replicas.REGISTER, replicaId, ReplicaState.READABLE, Date.now());
    }

    async deregisterReplica(replicaId: string): Promise<void> {
        this.log("PartitionDO", `deregisterReplica id=${replicaId}`);
        this.sql.exec(PartitionDOQueries.Replicas.DEREGISTER, replicaId);
    }

    async getRoutingConfig(): Promise<RoutingTable> {
        const cursor = this.sql.exec(PartitionDOQueries.Replicas.GET_READABLE, ReplicaState.READABLE);
        const rows = Array.from(cursor);
        const replicaIds = rows.map((r: any) => r.id as string);

        this.log("PartitionDO", `getRoutingConfig: ${replicaIds.length} readable replicas`);

        return {
            version: Date.now(),
            partitions: 100,
            replicas: {
                0: replicaIds
            }
        };
    }

    // --- Autoscaling ---
    async reportLoad(requests: number): Promise<void> {
        this.loadCounter += requests;
        this.log("PartitionDO", `reportLoad: counter=${this.loadCounter}`);

        // Simple Threshold: Every 10 requests, verify replica count
        if (this.loadCounter > 10) {
            this.loadCounter = 0;
            await this.checkScaling();
        }
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
