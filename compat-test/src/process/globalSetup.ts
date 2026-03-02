import { setupTestEnvironment, teardownTestEnvironment } from "./lifecycleManager.js";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function setup() {
    const env = await setupTestEnvironment();
    fs.writeFileSync(path.resolve(__dirname, "../../.test-ports.json"), JSON.stringify(env));
    process.env.ORACLE_PORT = env.oraclePort.toString();
    process.env.TEST_PORT = env.testPort.toString();
}

export async function teardown() {
    teardownTestEnvironment();
}
