import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createTestClient } from "./client/endpointConfig.js";
import { compare, compareError } from "./diff/comparator.js";

let oracleClient: DynamoDBClient;
let testClient: DynamoDBClient;

export function getClients() {
    if (!oracleClient || !testClient) {
        oracleClient = createTestClient(parseInt(process.env.ORACLE_PORT || "8000", 10), "/");
        testClient = createTestClient(parseInt(process.env.TEST_PORT || "8787", 10), "/api/");
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
