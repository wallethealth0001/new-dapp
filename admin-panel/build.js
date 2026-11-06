const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const outputDirectory = path.join(root, "dist");

function readApiBaseUrlFromEnvFile() {
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

function getApiBaseUrl() {
  const value = (process.env.VITE_API_BASE_URL ?? readApiBaseUrlFromEnvFile()).trim().replace(/\/+$/, "");
  if (!value) {
    throw new Error("VITE_API_BASE_URL is required. Set it in admin-panel/.env or the Vercel project environment.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_API_BASE_URL must be an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("VITE_API_BASE_URL must be an absolute HTTP or HTTPS URL without credentials, query, or fragment.");
  }

  return value;
}

function build() {
  const apiBaseUrl = getApiBaseUrl();
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, "index.html"), path.join(outputDirectory, "index.html"));
  fs.copyFileSync(path.join(root, "admin.js"), path.join(outputDirectory, "admin.js"));
  fs.writeFileSync(
    path.join(outputDirectory, "admin-panel-config.js"),
    `window.__ADMIN_PANEL_CONFIG__ = Object.freeze(${JSON.stringify({ VITE_API_BASE_URL: apiBaseUrl })});\n`
  );
  console.log(`Built admin panel in ${outputDirectory}`);
}

try {
  build();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
