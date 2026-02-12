/**
 * Debug Logging Utility for ShvmDB
 * 
 * Controlled by the `SHVM_DEBUG` env var:
 *   - "true" → all debug logs emitted (local dev)
 *   - unset/anything else → silent (production)
 * 
 * Errors always log regardless of SHVM_DEBUG.
 */

export interface Logger {
    (tag: string, msg: string, ...args: any[]): void;
    warn(tag: string, msg: string, ...args: any[]): void;
    error(tag: string, msg: string, ...args: any[]): void;
}

const PREFIX = "[shvm-db]";

function buildLogger(enabled: boolean): Logger {
    const log = function (tag: string, msg: string, ...args: any[]) {
        if (enabled) console.log(`${PREFIX}[${tag}]`, msg, ...args);
    } as Logger;

    log.warn = (tag: string, msg: string, ...args: any[]) => {
        if (enabled) console.warn(`${PREFIX}[${tag}]`, msg, ...args);
    };

    log.error = (tag: string, msg: string, ...args: any[]) => {
        // errors always log regardless of debug flag
        console.error(`${PREFIX}[${tag}]`, msg, ...args);
    };

    return log;
}

/** Logger for the main Worker handler — reads SHVM_DEBUG from Env */
export function createLogger(env: { SHVM_DEBUG?: string }): Logger {
    return buildLogger(env.SHVM_DEBUG === "true");
}

/** Logger for Durable Objects — pass the debug flag string directly */
export function createDOLogger(debugFlag?: string): Logger {
    return buildLogger(debugFlag === "true");
}
