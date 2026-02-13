import { PARTITION_KEY_MAX_SIZE, SORT_KEY_MAX_SIZE, ITEM_MAX_SIZE } from './constants';
import { TableMetadata } from './types';

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

function calculateSize(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') {
        return new TextEncoder().encode(value).length;
    } else if (typeof value === 'number') {
        return 8; // approximate
    } else if (typeof value === 'boolean') {
        return 1;
    } else if (typeof value === 'object') {
        // Handle DynamoDB JSON format or plain JSON
        return new TextEncoder().encode(JSON.stringify(value)).length;
    }
    return 0;
}

export function validateKey(name: string, value: any, maxSize: number): void {
    const size = calculateSize(value);
    if (size > maxSize) {
        throw new ValidationError(`${name} size ${size} bytes exceeds limit of ${maxSize} bytes`);
    }
}

export function validateItemAgainstSchema(item: any, metadata: TableMetadata): void {
    // 1. Validate Item Size
    const size = calculateSize(item);
    if (size > ITEM_MAX_SIZE) {
        throw new ValidationError(`Item size ${size} bytes exceeds limit of ${ITEM_MAX_SIZE} bytes`);
    }

    // 2. Validate Keys Existence and Types
    for (const keySchema of metadata.KeySchema) {
        const attrName = keySchema.AttributeName;
        let attrVal = item[attrName];

        if (!attrVal) {
            if (keySchema.KeyType === 'RANGE') {
                const def = metadata.AttributeDefinitions.find(d => d.AttributeName === attrName);
                if (def) {
                    if (def.AttributeType === 'S') {
                        attrVal = { S: "default" };
                        item[attrName] = attrVal;
                    } else if (def.AttributeType === 'N') {
                        attrVal = { N: "0" };
                        item[attrName] = attrVal;
                    } else if (def.AttributeType === 'B') {
                        attrVal = { B: "" };
                        item[attrName] = attrVal;
                    }
                }
            }

            if (!attrVal) {
                throw new ValidationError(`Missing key attribute: ${attrName}`);
            }
        }

        const def = metadata.AttributeDefinitions.find(d => d.AttributeName === attrName);
        if (def) {
            validateType(attrName, attrVal, def.AttributeType);

            // Validate Max Size for Keys
            const rawValue = getRawValue(attrVal);
            const limit = keySchema.KeyType === 'HASH' ? PARTITION_KEY_MAX_SIZE : SORT_KEY_MAX_SIZE;
            validateKey(attrName, rawValue, limit);
        }
    }
}

export function validateItem(item: any): void {
    // Deprecated single-table validation, keeping for backward compatibility if needed, 
    // but ideally we switch to schema validation.
    const size = calculateSize(item);
    if (size > ITEM_MAX_SIZE) {
        throw new ValidationError(`Item size ${size} bytes exceeds limit of ${ITEM_MAX_SIZE} bytes`);
    }

    // Check PK
    const pk = item.PK || item.pk || item.id;
    if (pk) {
        const val = getRawValue(pk);
        validateKey("Partition Key", val, PARTITION_KEY_MAX_SIZE);
    }

    // Check SK
    const sk = item.SK || item.sk;
    if (sk) {
        const val = getRawValue(sk);
        validateKey("Sort Key", val, SORT_KEY_MAX_SIZE);
    }
}

function getRawValue(typedValue: any): any {
    if (!typedValue) return typedValue;
    if (typedValue.S !== undefined) return typedValue.S;
    if (typedValue.N !== undefined) return typedValue.N;
    if (typedValue.B !== undefined) return typedValue.B;
    return typedValue;
}

function validateType(name: string, value: any, type: "S" | "N" | "B"): void {
    if (type === 'S' && value.S === undefined) throw new ValidationError(`Attribute ${name} must be of type String`);
    if (type === 'N' && value.N === undefined) throw new ValidationError(`Attribute ${name} must be of type Number`);
    if (type === 'B' && value.B === undefined) throw new ValidationError(`Attribute ${name} must be of type Binary`);
}
