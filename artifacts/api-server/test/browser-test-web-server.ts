import { spawn } from "node:child_process";
import { createServer } from "node:net";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a local browser-test port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function startDinarBrowserTestWeb(apiProxyTarget: string): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const port = await availablePort();
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@workspace/dinar",
      "run",
      "dev",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        BASE_PATH: "/",
        API_PROXY_TARGET: apiProxyTarget,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(3_000),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stop();
      throw new Error(
        `Dinar browser-test web server exited before becoming ready:\n${output}`,
      );
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return { baseUrl, stop };
    } catch {
      // Keep waiting while Vite starts; startup errors are reported below.
    }
    await sleep(200);
  }
  await stop();
  throw new Error(
    `Dinar browser-test web server did not become ready within 60 seconds:\n${output}`,
  );
}