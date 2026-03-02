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
        throw new ValidationError("Hash primary key values must be under 2048 bytes, and range primary key values must be under 1024 bytes");
    }
}

export function validateAttributeValue(value: any, depth: number = 0): void {
    if (depth >= 32) {
        throw new ValidationError("Nesting Levels have exceeded supported limits: Attributes in the item have nested levels beyond supported limit");
    }
    if (value === null || value === undefined) return;

    if (value.SS !== undefined) {
        if (!Array.isArray(value.SS) || value.SS.length === 0) {
            throw new ValidationError("One or more parameter values were invalid: An string set  may not be empty");
        }
        const unique = new Set(value.SS);
        if (unique.size !== value.SS.length) {
            throw new ValidationError(`One or more parameter values were invalid: Input collection [${value.SS.join(', ')}] contains duplicates`);
        }
    }
    if (value.NS !== undefined) {
        if (!Array.isArray(value.NS) || value.NS.length === 0) {
            throw new ValidationError("One or more parameter values were invalid: An number set  may not be empty");
        }
        const unique = new Set(value.NS);
        if (unique.size !== value.NS.length) {
            throw new ValidationError(`One or more parameter values were invalid: Input collection [${value.NS.join(', ')}] contains duplicates`);
        }
    }
    if (value.BS !== undefined) {
        if (!Array.isArray(value.BS) || value.BS.length === 0) {
            throw new ValidationError("One or more parameter values were invalid: An binary set  may not be empty");
        }
    }
    if (value.M !== undefined && typeof value.M === 'object') {
        for (const k in value.M) {
            validateAttributeValue(value.M[k], depth + 1);
        }
    }
    if (value.L !== undefined && Array.isArray(value.L)) {
        for (const v of value.L) {
            validateAttributeValue(v, depth + 1);
        }
    }
}

export function validateItemAgainstSchema(item: any, metadata: TableMetadata): void {
    // 1. Validate Item Size
    const size = calculateSize(item);
    if (size > ITEM_MAX_SIZE) {
        throw new ValidationError(`Item size has exceeded the maximum allowed size`);
    }

    if (item && typeof item === "object") {
        for (const key in item) {
            validateAttributeValue(item[key]);
        }
    }

    // 2. Validate Keys Existence and Types
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
