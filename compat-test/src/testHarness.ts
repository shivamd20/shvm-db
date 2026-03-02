import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createTestClient } from "./client/endpointConfig.js";
import { compare, compareError } from "./diff/comparator.js";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let oracleClient: DynamoDBClient;
let testClient: DynamoDBClient;

export function getClients() {
    if (!oracleClient || !testClient) {
        let oraclePort = parseInt(process.env.ORACLE_PORT || "8000", 10);
        let testPort = parseInt(process.env.TEST_PORT || "8787", 10);

        try {
            const portsStr = fs.readFileSync(path.resolve(__dirname, "../.test-ports.json"), "utf8");
            const parsed = JSON.parse(portsStr);
            if (parsed.oraclePort) oraclePort = parsed.oraclePort;
            if (parsed.testPort) testPort = parsed.testPort;
        } catch (e) {
            // ignore
        }

        oracleClient = createTestClient(oraclePort, "/");
        testClient = createTestClient(testPort, "/api/");
    }
    return { oracleClient, testClient };
}

export async function executeAgainstBoth(
    commandFactory: (client: DynamoDBClient) => Promise<any>
) {
    const { oracleClient, testClient } = getClients();

    let oracleResult, testResult;
    let oracleError, testError;

    try {
        oracleResult = await commandFactory(oracleClient);
    } catch (e) {
        oracleError = e;
    }

    try {
        testResult = await commandFactory(testClient);
    } catch (e) {
        testError = e;
    }

    if (oracleError || testError) {
        // If one errors and the other doesn't, we want compareError to fail
        compareError(oracleError, testError);
    } else {
        compare(oracleResult, testResult);
    }
}
