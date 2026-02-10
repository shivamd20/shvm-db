import { DurableObject } from "cloudflare:workers";
import { SubDO } from "./sub-do";

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
}

export class PartitionDO extends DurableObject {
    // env property is already defined in parent DurableObject<Env>

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    private getSubDO(sk: string): DurableObjectStub<SubDO> {
        // Simple consistent hashing: hash(sk) % 100
        let hash = 0;
        for (let i = 0; i < sk.length; i++) {
            hash = ((hash << 5) - hash) + sk.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        const partitionId = Math.abs(hash) % 100;
        const subDoId = this.env.SUB_DO.idFromName(`sub-partition-${partitionId}`);
        return this.env.SUB_DO.get(subDoId);
    }

    async putItem(sk: string, value: unknown): Promise<void> {
        const subDo = this.getSubDO(sk);
        await subDo.putItem(sk, value);
    }

    async getItem(sk: string): Promise<unknown | null> {
        const subDo = this.getSubDO(sk);
        return await subDo.getItem(sk);
    }

    async deleteItem(sk: string): Promise<void> {
        const subDo = this.getSubDO(sk);
        await subDo.deleteItem(sk);
    }
}
