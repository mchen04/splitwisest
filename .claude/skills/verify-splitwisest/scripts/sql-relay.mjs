#!/usr/bin/env node
import { createServer, request } from "node:http";

const [listen, target] = [Number(process.argv[2] ?? 54545), new URL(process.argv[3] ?? "http://127.0.0.1:54544/sql")];
let count = 0;
createServer((req, res) => {
  if (req.url === "/__count") {
    res.end(JSON.stringify({ count }));
    return;
  }
  count++;
  const upstream = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
}).listen(listen, "127.0.0.1");
