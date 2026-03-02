export function normalize(obj: any): any {
    if (obj === null || obj === undefined) {
        return null;
    }

    if (Array.isArray(obj)) {
        return obj.map(normalize);
    }

    if (typeof obj === "object") {
        if (obj instanceof Date) {
            return "DATETIME_STUB";
        }
        const keys = Object.keys(obj).sort();
        const result: any = {};
        for (const key of keys) {
            if (key === "$metadata") {
                const metadata = obj[key] || {};
                result[key] = {
                    httpStatusCode: metadata.httpStatusCode,
                };
                continue;
            }
            if (key === "CreationDateTime" || key === "LastDecreaseDateTime" || key === "LastIncreaseDateTime" || key === "LastUpdateToPayPerRequestDateTime") {
                result[key] = "DATETIME_STUB";
                continue;
            }
            if (key === "ItemCount" || key === "TableSizeBytes") {
                result[key] = "STATS_STUB";
                continue;
            }
            if (key === "ConsumedCapacity") {
                // Strip consumed capacity since it's highly implementation-specific and often returned by Local even when not requested
                continue;
            }

            result[key] = normalize(obj[key]);
        }
        return result;
    }

    return obj;
}

export function normalizeError(err: any): any {
    // If undefined/null, return null rather than dying
    if (!err) return null;
    return {
        name: err.name,
        message: err.message,
        $fault: err.$fault ? err.$fault : "client", // SDK sometimes returns fault, fallback to client
    };
}
