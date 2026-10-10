// Tiny dev server with live reload. No dependencies: `node serve.mjs [port]` (default 5173).
// Serves this folder and reloads the page whenever a file changes.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 5173;
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const clients = new Set();
const live = '<script>new EventSource("/__live").onmessage = () => location.reload();</script>';

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/__live") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(ext === ".html" ? buf.toString().replace("</body>", live + "</body>") : buf);
    });
  })
  .listen(port, "localhost", () => console.log(`Dev server: http://localhost:${port}  (Ctrl+C to stop)`));

let timer;
fs.watch(root, { recursive: true }, (_, name) => {
  if (name && /node_modules|\.git/.test(name)) return;
  clearTimeout(timer);
  timer = setTimeout(() => clients.forEach((c) => c.write("data: reload\n\n")), 80);
});
