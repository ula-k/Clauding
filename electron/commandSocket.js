// The `clauding` command (bin/clauding) talks to the running app over a Unix
// domain socket at <userData>/clauding.sock. Protocol: one JSON object per
// line in each direction. Requests carry `command` ("open", "panel", "tabs"),
// the caller's `terminalId` (from CLAUDING_TERMINAL_ID in the pty) and `cwd`;
// the reply is { ok: true, message } or { ok: false, error }.
//
// The socket file is chmod 0600, so only processes of the same user can
// connect (macOS checks the file mode on connect).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_LINE_CHARACTERS = 64000;

export function startCommandSocket({ socketPath, handleRequest, log }) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    // No stale socket to remove.
  }

  const server = net.createServer((connection) => {
    let buffered = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_CHARACTERS) {
        connection.end(`${JSON.stringify({ ok: false, error: "Request too long." })}\n`);
        return;
      }
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        respond(connection, line);
        newlineIndex = buffered.indexOf("\n");
      }
    });
    connection.on("error", () => {});
  });

  async function respond(connection, line) {
    let request = null;
    try {
      request = JSON.parse(line);
    } catch (error) {
      connection.write(`${JSON.stringify({ ok: false, error: "Malformed request (expected one JSON object per line)." })}\n`);
      return;
    }
    try {
      const message = await handleRequest(request || {});
      connection.write(`${JSON.stringify({ ok: true, message })}\n`);
    } catch (error) {
      connection.write(`${JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) })}\n`);
    }
  }

  server.on("error", (error) => {
    if (log) {
      log(`[socket] ${error.message}`);
    }
  });
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (error) {
      // Best effort; the folder itself is inside the user's Library.
    }
    if (log) {
      log(`[socket] listening on ${socketPath}`);
    }
  });

  return function stop() {
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      // Already gone.
    }
  };
}
