const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function readApiBaseUrl() {
  const envFile = path.join(root, ".env");
  let contents;
  try {
    contents = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }

  const line = contents.split(/\r?\n/).find((entry) => /^\s*(?:export\s+)?VITE_API_BASE_URL\s*=/.test(entry));
  if (!line) return "";

  let value = line.replace(/^\s*(?:export\s+)?VITE_API_BASE_URL\s*=\s*/, "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  if (pathname === "/admin-panel-config.js") {
    let apiBaseUrl;
    try {
      apiBaseUrl = readApiBaseUrl();
    } catch (error) {
      console.error("Failed to read admin panel .env:", error);
      response.writeHead(500);
      response.end("Failed to read admin panel configuration");
      return;
    }

    const config = `window.__ADMIN_PANEL_CONFIG__ = Object.freeze(${JSON.stringify({ VITE_API_BASE_URL: apiBaseUrl })});`;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(config),
      "Content-Type": "text/javascript; charset=utf-8"
    });
    response.end(request.method === "HEAD" ? undefined : config);
    return;
  }

  const requestedFile = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, requestedFile);
  const relativePath = path.relative(root, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  if (relativePath.split(path.sep).some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        response.writeHead(404);
        response.end("Not found");
      } else {
        console.error("Failed to read admin panel file:", error);
        response.writeHead(500);
        response.end("Internal server error");
      }
      return;
    }

    if (!stats.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Length": stats.size,
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", (streamError) => {
      console.error("Failed to stream admin panel file:", streamError);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    stream.pipe(response);
  });
});

server.listen(3002, () => {
  console.log("Admin panel listening on http://localhost:3002");
});
