
import { DurableObject } from "cloudflare:workers";
import { LRUCache, BloomFilter } from "./cache";
import { BLOOM_FILTER_SIZE, LRU_CACHE_CAPACITY } from "./constants";
import type { PartitionDO } from "./partition-do";
import { ReplicationMessage, Role, ReplicaState } from "./types";
import { createDOLogger, Logger } from "./debug";

export interface Env {
    PARTITION_DO: DurableObjectNamespace<PartitionDO>;
    SUB_DO: DurableObjectNamespace<SubDO>;
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
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS items_v2 (
                sk TEXT,
                version INTEGER,
                value BLOB,
                deleted INTEGER DEFAULT 0,
                PRIMARY KEY (sk, version DESC)
            );
            CREATE TABLE IF NOT EXISTS cursors (
                id TEXT PRIMARY KEY,
                val INTEGER
            );
        `);
    }

    private loadState() {
        // Load Role
        const roleCursor = this.sql.exec("SELECT value FROM metadata WHERE key = ?", "role");
        const roleRow = Array.from(roleCursor)[0] as any;
        if (roleRow) {
            this.role = roleRow.value as Role;
        }

        // Load Cursor
        const cursorIter = this.sql.exec("SELECT val FROM cursors WHERE id = ?", "lastApplied");
        const cursorRow = Array.from(cursorIter)[0] as any;
        if (cursorRow) {
            this.lastAppliedVersion = cursorRow.val as number;
        }

        // Load Replica State
        const stateIter = this.sql.exec("SELECT value FROM metadata WHERE key = ?", "replicaState");
        const stateRow = Array.from(stateIter)[0] as any;
        if (stateRow) {
            this.replicaState = stateRow.value as ReplicaState;
        }

        // Rebuild BF if needed (skip for now for speed)
    }

    async init(role: Role) {
        if (this.role !== role) {
            this.log("SubDO", `init: role change ${this.role} -> ${role} (id=${this.state.id.toString()})`);
            this.role = role;
            this.sql.exec("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", "role", role);

            if (role === Role.LEADER || role === Role.STANDBY) {
                this.setReplicaState(ReplicaState.READABLE);
            }
        }
    }

    private setReplicaState(newState: ReplicaState) {
        this.log("SubDO", `state transition: ${this.replicaState} -> ${newState} (id=${this.state.id.toString()})`);
        this.replicaState = newState;
        this.sql.exec("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", "replicaState", newState);
    }

    private persistCursor(v: number) {
        this.lastAppliedVersion = v;
        this.sql.exec("INSERT OR REPLACE INTO cursors (id, val) VALUES (?, ?)", "lastApplied", v);
    }

    // --- LEADER ONLY ---

    private getNextVersion(): number {
        // Atomic increment
        // In SQLite DO, we can use a sequence or just a singleton row
        this.sql.exec("INSERT OR IGNORE INTO cursors (id, val) VALUES ('global_seq', 0)");
        this.sql.exec("UPDATE cursors SET val = val + 1 WHERE id = 'global_seq'");
        const cursor = this.sql.exec("SELECT val FROM cursors WHERE id = 'global_seq'");
        const row = Array.from(cursor)[0] as any;
        return row!.val as number;
    }

    async putItem(sk: string, value: unknown, partitionId: number, tableName: string = 'default'): Promise<void> {
        if (this.role !== Role.LEADER) throw new Error(`Not Leader: I am ${this.role}`);

        const version = this.getNextVersion();
        this.log("SubDO", `[LEADER] putItem sk=${sk} v=${version} partition=${partitionId} table=${tableName}`);

        // 1. Log locally
        this.applyToLocal(sk, version, value, 0);

        // 2. Publish
        await this.env.REPLICATION_QUEUE.send({
            type: 'PUT',
            sk,
            value,
            version,
            partitionId,
            tableName,
            replicationFactor: 0
        });
    }

    async deleteItem(sk: string, partitionId: number, tableName: string = 'default'): Promise<void> {
        if (this.role !== Role.LEADER) throw new Error(`Not Leader: I am ${this.role}`);

        const version = this.getNextVersion();
        this.log("SubDO", `[LEADER] deleteItem sk=${sk} v=${version} partition=${partitionId} table=${tableName}`);
        this.applyToLocal(sk, version, null, 1);

        await this.env.REPLICATION_QUEUE.send({
            type: 'DELETE',
            sk,
            version,
            partitionId,
            tableName,
            replicationFactor: 0
        });
    }

    // --- COMMON APPLY ---

    applyMutation(msg: ReplicationMessage) {
        if (msg.version <= this.lastAppliedVersion) {
            this.log("SubDO", `applyMutation SKIP (idempotent) version=${msg.version} lastApplied=${this.lastAppliedVersion}`);
            return;
        }

        this.log("SubDO", `applyMutation type=${msg.type} sk=${msg.sk} v=${msg.version} role=${this.role} state=${this.replicaState}`);

        if (msg.type === 'PUT') {
            this.applyToLocal(msg.sk, msg.version, msg.value, 0);
        } else if (msg.type === 'DELETE') {
            this.applyToLocal(msg.sk, msg.version, null, 1);
        }

        this.persistCursor(msg.version);

        if (this.role === Role.REPLICA && this.replicaState === ReplicaState.CATCHING_UP) {
            if (this.lastAppliedVersion >= this.migrationTargetVersion) {
                this.log("SubDO", `Promoting to READABLE (caught up to version ${this.migrationTargetVersion})`);
                this.promoteToReadable();
            }
        }
    }

    private applyToLocal(sk: string, version: number, value: any, deleted: number) {
        this.sql.exec(`
            INSERT INTO items_v2 (sk, version, value, deleted) VALUES (?, ?, ?, ?)
        `, sk, version, deleted === 0 ? JSON.stringify(value) : null, deleted);

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
        const cursor = this.sql.exec(`
            SELECT sk, version, value, deleted FROM items_v2 
            WHERE version > ? AND version <= ? 
            ORDER BY version ASC
        `, sinceVersion, untilVersion);

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

        const standbyRef = this.sql.exec("SELECT value FROM metadata WHERE key = ?", "standbyRef");
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

    async getItem(sk: string): Promise<unknown | null> {
        this.log("SubDO", `getItem sk=${sk} role=${this.role} state=${this.replicaState}`);

        if (this.replicaState !== ReplicaState.READABLE && this.role !== Role.LEADER && this.role !== Role.STANDBY) {
            throw new Error(`Replica not readable yet. State: ${this.replicaState}`);
        }

        const cached = this.lru.get(sk);
        if (cached !== undefined) {
            this.log("SubDO", `getItem CACHE HIT sk=${sk}`);
            return cached;
        }

        const cursor = this.sql.exec(`SELECT value, deleted FROM items_v2 WHERE sk = ? ORDER BY version DESC LIMIT 1`, sk);
        const row = Array.from(cursor)[0] as any;

        if (!row || (row.deleted as number) === 1) {
            this.log("SubDO", `getItem NOT FOUND sk=${sk}`);
            return null;
        }

        const val = JSON.parse(row.value as string);
        this.lru.put(sk, val);
        this.log("SubDO", `getItem FOUND sk=${sk}`);
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
