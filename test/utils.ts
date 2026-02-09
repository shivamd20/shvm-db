import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { Env } from "../src/index";

export class TestClient {
    private globalUrl: string | undefined;

    constructor() {
        try {
            // Check if running with a global URL for integration testing
            // @ts-ignore
            this.globalUrl = process.env.TEST_GLOBAL_URL;
            if (this.globalUrl) {
                console.log(`Running tests against global URL: ${this.globalUrl}`);
            }
        } catch (e) {
            this.globalUrl = undefined;
        }
    }

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        if (this.globalUrl) {
            // When running against a deployed worker, use standard fetch
            // Ensure the URL is absolute by combining with globalUrl if it's relative
            let urlStr = input.toString();
            if (urlStr.startsWith("/")) {
                urlStr = new URL(urlStr, this.globalUrl).toString();
            } else if (!urlStr.startsWith("http")) {
                urlStr = new URL(urlStr, this.globalUrl).toString();
            }

            // If input is a URL string, use it. If it's a Request, clone logic is complex, 
            // so we assume input is string for our helpers.
            return fetch(urlStr, init);
        } else {
            // Local worker testing
            const req = new Request(input, init);
            const ctx = createExecutionContext();
            const res = await worker.fetch(req, env as unknown as Env, ctx);
            await waitOnExecutionContext(ctx);
            return res;
        }
    }

    async dynamoRequest(target: string, body: any) {
        // Construct a request that mimics DynamoDB SDK
        // x-amz-target format: "DynamoDB_20120810.Operation"
        return this.fetch("http://example.com/api", {
            method: "POST",
            headers: {
                "x-amz-target": target,
                "Content-Type": "application/x-amz-json-1.0"
            },
            body: JSON.stringify(body)
        });
    }
}
