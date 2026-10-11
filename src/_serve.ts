/** Serves ./site on :8787 so you can check the deploy locally before uploading. */
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "site");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".json": "application/json",
  ".png": "image/png", ".css": "text/css", ".js": "text/javascript",
};

// 8787 is also wrangler's default dev port, and an orphaned tsx child can keep
// holding it. Walk forward to the next free port instead of dying.
const START = Number(process.env.PORT ?? 8787);
const MAX_TRIES = 10;

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

let port = START;
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE" && port < START + MAX_TRIES) {
    console.log(`  port ${port} busy, trying ${port + 1} ...`);
    server.listen(++port);
    return;
  }
  console.error(e.message);
  process.exitCode = 1;
});
server.on("listening", () => {
  console.log(`\n  serving ./site  ->  http://localhost:${port}`);
  console.log(`  metadata        ->  http://localhost:${port}/token/metadata.json`);
  console.log(`\n  Ctrl+C to stop.\n`);
});
server.listen(port);
