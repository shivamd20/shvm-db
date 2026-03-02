import { ChildProcess } from "child_process";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { spawnDynamoLocal } from "./spawnDynamoLocal.js";
import { spawnDbShvm } from "./spawnDbShvm.js";
import { createTestClient } from "../client/endpointConfig.js";

interface TestEnvironment {
    oraclePort: number;
    testPort: number;
}

let oracleProcess: ChildProcess | null = null;
let testProcess: ChildProcess | null = null;

async function waitForReady(port: number, name: string, path: string = "") {
    const client = createTestClient(port, path);
    const start = Date.now();
    while (Date.now() - start < 30000) {
        try {
            await client.send(new ListTablesCommand({}));
            console.log(`[Lifecycle] ${name} on port ${port} is ready.`);
            return;
        } catch (e: any) {
            await new Promise(r => setTimeout(r, 300));
        }
    }
    throw new Error(`Timeout waiting for ${name} on port ${port} to become ready.`);
}

export async function setupTestEnvironment(): Promise<TestEnvironment> {
    console.log("[Lifecycle] Spawning Oracle (DynamoDB Local)...");
    const oracle = await spawnDynamoLocal();
    oracleProcess = oracle.process;

    console.log("[Lifecycle] Spawning Test Server (shvm-db)...");
    const testNode = await spawnDbShvm();
    testProcess = testNode.process;

    console.log(`[Lifecycle] Waiting for health checks (Oracle: ${oracle.port}, Test: ${testNode.port})...`);
    await Promise.all([
        waitForReady(oracle.port, "Oracle (DynamoDB Local)", "/"),
        waitForReady(testNode.port, "Test Server (shvm-db)", "/api/")
    ]);

    return {
        oraclePort: oracle.port,
        testPort: testNode.port
    };
}

export function teardownTestEnvironment() {
    if (oracleProcess) {
        oracleProcess.kill("SIGKILL");
        oracleProcess = null;
    }
    if (testProcess) {
        testProcess.kill("SIGKILL");
        testProcess = null;
    }
}
