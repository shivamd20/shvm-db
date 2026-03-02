import { spawn, ChildProcess } from "child_process";
import getPort from "get-port";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function spawnDbShvm(): Promise<{ port: number, process: ChildProcess }> {
  const port = await getPort();
  const rootDir = resolve(__dirname, "../../.."); // from compat-test/src/process/ to root
  const persistDir = resolve(__dirname, "../../.wrangler-test-state");

  // Clean up previous state to ensure a fresh database just like DynamoLocal
  rmSync(persistDir, { recursive: true, force: true });

  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", port.toString(), "--persist-to", persistDir],
    { cwd: rootDir, stdio: "inherit", detached: true }
  );

  return { port, process: child };
}
