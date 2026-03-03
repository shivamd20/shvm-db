import { ValidationError } from "./validation";

export function evaluateCondition(item: any, conditionExpression?: string, names?: Record<string, string>, values?: Record<string, any>): boolean {
    if (!conditionExpression) return true;

    let expr = conditionExpression.trim();

    // Very basic parsing for attribute_not_exists and exact match (x = :v)
    const notExistsMatch = expr.match(/attribute_not_exists\(([^)]+)\)/);
    if (notExistsMatch) {
        const attr = notExistsMatch[1].trim();
        const realAttr = names?.[attr] || attr;
        // Reserved keyword check (if no mapping provided)
        if (!names?.[attr] && ['exists', 'name', 'status'].includes(realAttr.toLowerCase())) {
            throw new ValidationError(`Invalid ConditionExpression: Attribute name is a reserved keyword; reserved keyword: ${realAttr}`);
        }
        if (item && item[realAttr] !== undefined) return false;
        return true; // it does not exist
    }

    const eqMatch = expr.match(/([^=]+)\s*=\s*(:\w+)/);
    if (eqMatch) {
        const attr = eqMatch[1].trim();
        const valKey = eqMatch[2].trim();
        const realAttr = names?.[attr] || attr;
        const expectedVal = values?.[valKey];
        const currentVal = item ? item[realAttr] : undefined;

        if (JSON.stringify(currentVal) !== JSON.stringify(expectedVal)) return false;
        return true;
    }

    return true; // default true if unknown expression for now
}

export function evaluateUpdateExpression(currentItem: Record<string, any>, updateExpression: string, names?: Record<string, string>, values?: Record<string, any>): void {
    const setMatch = updateExpression.match(/SET\s+([^R]+)/);
    if (setMatch) {
        const parts = setMatch[1].split(',');
        for (const p of parts) {
            const [attr, valVar] = p.split('=').map(s => s.trim());
            const realAttr = names?.[attr] || attr;
            if (values && values[valVar]) {
                currentItem[realAttr] = values[valVar];
            }
        }
    }

    const removeMatch = updateExpression.match(/REMOVE\s+(.+)/);
    if (removeMatch) {
        const parts = removeMatch[1].split(',');
        for (let attr of parts) {
            attr = attr.trim();
            const realAttr = names?.[attr] || attr;
            delete currentItem[realAttr];
        }
    }
}
