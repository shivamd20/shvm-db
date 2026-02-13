
export interface KeySchemaElement {
    AttributeName: string;
    KeyType: "HASH" | "RANGE";
}

export interface AttributeDefinition {
    AttributeName: string;
    AttributeType: "S" | "N" | "B";
}

export interface ProvisionedThroughput {
    ReadCapacityUnits: number;
    WriteCapacityUnits: number;
}

export interface TableMetadata {
    TableName: string;
    KeySchema: KeySchemaElement[];
    AttributeDefinitions: AttributeDefinition[];
    TableStatus: "CREATING" | "ACTIVE" | "DELETING";
    CreationDateTime: number;
    ProvisionedThroughput?: ProvisionedThroughput;
}

export interface TableDescription {
    Table: TableMetadata;
}

export interface CreateTableInput {
    TableName: string;
    KeySchema: KeySchemaElement[];
    AttributeDefinitions: AttributeDefinition[];
    ProvisionedThroughput?: ProvisionedThroughput;
}

export interface AttributeValue {
    S?: string;
    N?: string;
    B?: string;
    [key: string]: any;
}

export interface AttributeValueUpdate {
    Value: AttributeValue;
    Action?: "PUT" | "DELETE" | "ADD";
}

export interface UpdateItemInput {
    TableName: string;
    Key: Record<string, AttributeValue>;
    AttributeUpdates: Record<string, AttributeValueUpdate>;
    ReturnValues?: string;
}

export enum Role {
    LEADER = 'LEADER',
    STANDBY = 'STANDBY',
    REPLICA = 'REPLICA'
}

export enum ReplicaState {
    CREATED = 'CREATED',
    BACKFILLING = 'BACKFILLING',
    CATCHING_UP = 'CATCHING_UP',
    READABLE = 'READABLE'
}

export interface RoutingTable {
    version: number;
    partitions: number; // e.g. 100
    // Dynamic routing map: partitionId -> list of READABLE replica IDs
    replicas: Record<number, string[]>;
}

export interface ReplicationMessage {
    type: 'PUT' | 'DELETE' | 'BACKFILL';
    sk: string;
    value?: unknown;
    version: number; // Monotonic Counter
    partitionId: number;
    tableName: string; // Table-scoped partition routing
    replicationFactor: number;
    // For backfill
    targetVersion?: number;
    batch?: ReplicationMessage[];
}
