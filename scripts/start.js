// `npm start`: boots the Vite dev server for the renderer, then launches
// Electron pointed at it. `npm run preview` (--built) skips Vite and loads
// the last `npm run build` output instead.
import { spawn } from "node:child_process";
import { createServer } from "vite";
import electronBinaryPath from "electron";

const useBuiltRenderer = process.argv.includes("--built");

async function main() {
  let developmentServer = null;
  const environment = { ...process.env };

  if (!useBuiltRenderer) {
    developmentServer = await createServer({ configFile: "vite.config.js" });
    await developmentServer.listen();
    const address = developmentServer.resolvedUrls.local[0];
    environment.VITE_DEV_SERVER_URL = address;
    console.log(`Renderer dev server at ${address}`);
  }

  const electronProcess = spawn(electronBinaryPath, ["."], {
    stdio: "inherit",
    env: environment
  });

  electronProcess.on("exit", async (exitCode) => {
    if (developmentServer) {
      await developmentServer.close();
    }
    process.exit(exitCode || 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
