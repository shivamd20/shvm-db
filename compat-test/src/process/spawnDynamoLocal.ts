import { spawn, ChildProcess } from "child_process";
import getPort from "get-port";

export async function spawnDynamoLocal(): Promise<{ port: number, process: ChildProcess }> {
    const port = await getPort();
    const child = spawn(
        "docker",
        ["run", "--rm", "-p", `${port}:8000`, "amazon/dynamodb-local"],
        { stdio: "inherit" }
    );

    return { port, process: child };
}
