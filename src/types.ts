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
