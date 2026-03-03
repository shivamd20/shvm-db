export interface MappedError {
    type: string;
    message: string;
    status: number;
}

export function mapDynamoError(err: any): MappedError {
    const errorPrefixes = [/^ValidationError: /, /^ValidationException: /, /^Error: /, /^ConditionalCheckFailedException: /];
    let message = err?.message || "Internal Server Error";
    let name = err?.name || "Error";

    for (const prefix of errorPrefixes) {
        message = message.replace(prefix, '');
    }

    if (name === "ValidationError" || name === "ValidationException" || message.includes("Validation") || message.includes("No defined key schema") || message.includes("Invalid ConditionExpression")) {
        return { type: "ValidationException", message, status: 400 };
    }

    if (message.includes("Cannot do operations on a non-existent table") || message.includes("ResourceNotFoundException")) {
        return { type: "ResourceNotFoundException", message, status: 400 };
    }

    if (message.includes("already exists") || name === "ResourceInUseException") {
        return { type: "ResourceInUseException", message: "Cannot create preexisting table", status: 400 };
    }

    if (name === "ConditionalCheckFailedException" || message.includes("ConditionalCheckFailedException") || message.includes("The conditional request failed")) {
        return { type: "ConditionalCheckFailedException", message, status: 400 };
    }

    return { type: "InternalServerError", message, status: 500 };
}
