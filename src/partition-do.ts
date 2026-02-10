import { DurableObject } from "cloudflare:workers";
import { SubDO } from "./sub-do";
import { RoutingTable } from "./types";


export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
}

export class PartitionDO extends DurableObject {
    private lastSave: Promise<void> = Promise.resolve();
    // In a real system, we would store the routing table in storage.
    // For now, we return a static configuration.

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    async getRoutingConfig(): Promise<RoutingTable> {
        return {
            version: 1,
            partitions: 100
        };
    }

    // New control plane methods could go here (e.g. split, metrics)
}
