import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export function createTestClient(port: number, path: string = "") {
    return new DynamoDBClient({
        region: "us-east-1",
        endpoint: `http://127.0.0.1:${port}${path}`,
        credentials: {
            accessKeyId: "dummy",
            secretAccessKey: "dummy"
        }
    });
}
