import { setupTestEnvironment, teardownTestEnvironment } from "./lifecycleManager.js";

export async function setup() {
    const env = await setupTestEnvironment();
    process.env.ORACLE_PORT = env.oraclePort.toString();
    process.env.TEST_PORT = env.testPort.toString();
}

export async function teardown() {
    teardownTestEnvironment();
}
