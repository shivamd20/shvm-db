import { z } from "zod";
import { PARTITION_KEY_MAX_SIZE, SORT_KEY_MAX_SIZE, ITEM_MAX_SIZE } from './constants';
import { TableMetadata } from "./types";

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

// Zod schema for deep DynamoDB AttributeValue (limited type depth for performance)
const DynamoValueSchema: z.ZodType<any> = z.lazy(() =>
    z.object({
        S: z.string().optional(),
        N: z.string().optional(),
        B: z.string().optional(),
        SS: z.array(z.string()).min(1, { message: "An string set  may not be empty" }).optional(),
        NS: z.array(z.string()).min(1, { message: "An number set  may not be empty" }).optional(),
        BS: z.array(z.string()).min(1, { message: "An binary set  may not be empty" }).optional(),
        M: z.record(z.string(), DynamoValueSchema).optional(),
        L: z.array(DynamoValueSchema).optional(),
        NULL: z.boolean().optional(),
        BOOL: z.boolean().optional(),
    }).refine((val) => Object.keys(val).length === 1, {
        message: "AttributeValue must contain exactly one of the supported data types",
    })
);

export const CreateTableSchema = z.object({
    TableName: z.string().min(3).max(255),
    KeySchema: z.array(
        z.object({
            AttributeName: z.string().min(1),
            KeyType: z.enum(["HASH", "RANGE"]),
        })
    ).min(1).max(2),
    AttributeDefinitions: z.array(
        z.object({
            AttributeName: z.string().min(1),
            AttributeType: z.enum(["S", "N", "B"]),
        })
    ).min(1),
    ProvisionedThroughput: z.object({
        ReadCapacityUnits: z.number().min(1),
        WriteCapacityUnits: z.number().min(1),
    }).optional(),
    BillingMode: z.enum(["PROVISIONED", "PAY_PER_REQUEST"]).optional(),
});

function calculateSize(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') {
        return new TextEncoder().encode(value).length;
    } else if (typeof value === 'number') {
        return 8; // approximate
    } else if (typeof value === 'boolean') {
        return 1;
    } else if (typeof value === 'object') {
        return new TextEncoder().encode(JSON.stringify(value)).length;
    }
    return 0;
}

function getRawValue(typedValue: any): any {
    if (!typedValue) return typedValue;
    if (typedValue.S !== undefined) return typedValue.S;
    if (typedValue.N !== undefined) return typedValue.N;
    if (typedValue.B !== undefined) return typedValue.B;
    return typedValue;
}

function validateDepthAndSets(value: any, depth: number = 0): void {
    if (depth > 32) {
        throw new ValidationError("Nesting Levels have exceeded supported limits: Attributes in the item have nested levels beyond supported limit");
    }
    if (value && typeof value === "object") {
        if (value.M) {
            for (const v of Object.values(value.M)) {
                validateDepthAndSets(v, depth + 1);
            }
        } else if (value.L) {
            for (const v of value.L) {
                validateDepthAndSets(v, depth + 1);
            }
        } else if (value.SS) {
            if (new Set(value.SS).size !== value.SS.length) throw new ValidationError(`One or more parameter values were invalid: Input collection [${value.SS.join(", ")}] contains duplicates`);
        } else if (value.NS) {
            if (new Set(value.NS).size !== value.NS.length) throw new ValidationError(`One or more parameter values were invalid: Input collection [${value.NS.join(", ")}] contains duplicates`);
        } else if (value.BS) {
            if (new Set(value.BS).size !== value.BS.length) throw new ValidationError(`One or more parameter values were invalid: Input collection [${value.BS.join(", ")}] contains duplicates`);
        }
    }
}

export function validateItemAgainstSchema(item: any, metadata: TableMetadata): void {
    const size = calculateSize(item);
    if (size > ITEM_MAX_SIZE) {
        throw new ValidationError(`Item size has exceeded the maximum allowed size`);
    }

    if (item && typeof item === "object") {
        for (const [k, v] of Object.entries(item)) {
            const parsed = DynamoValueSchema.safeParse(v);
            if (!parsed.success) {
                const message = parsed.error.issues[0]?.message || "Invalid AttributeValue";
                // Convert Zod deep errors into typical AWS API errors
                throw new ValidationError(`One or more parameter values were invalid: ${message}`);
            }
            validateDepthAndSets(v, 1);
        }
    }

    for (const keySchema of metadata.KeySchema) {
        const attrName = keySchema.AttributeName;
        let attrVal = item[attrName];

        if (!attrVal) {
            throw new ValidationError(`One of the required keys was not given a value`);
        }

        const def = metadata.AttributeDefinitions.find(d => d.AttributeName === attrName);
        if (def) {
            const type = def.AttributeType;
            if ((type === 'S' && attrVal.S === undefined) ||
                (type === 'N' && attrVal.N === undefined) ||
                (type === 'B' && attrVal.B === undefined)) {
                throw new ValidationError(`One or more parameter values were invalid: Type mismatch for key`);
            }
            if (type === 'S' && attrVal.S === "") {
                throw new ValidationError(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${attrName}`);
            }
            if (type === 'B' && attrVal.B === "") {
                throw new ValidationError(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: ${attrName}`);
            }

            const rawValue = getRawValue(attrVal);
            const limit = keySchema.KeyType === 'HASH' ? PARTITION_KEY_MAX_SIZE : SORT_KEY_MAX_SIZE;
            const size = calculateSize(rawValue);
            if (size > limit) {
                throw new ValidationError("Hash primary key values must be under 2048 bytes, and range primary key values must be under 1024 bytes");
            }
        }
    }
}
