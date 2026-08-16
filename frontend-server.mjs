import { spawn } from "node:child_process";
import http from "node:http";

const host = "0.0.0.0";
const port = Number(process.env.PORT || 8080);
const appPort = 3001;
const backendUrl = process.env.OCR_BACKEND_URL;
const backendAudience = process.env.OCR_BACKEND_AUDIENCE || backendUrl;
const maxRequestBytes = 25 * 1024 * 1024;
const apiRoutes = new Map([
  ["/api/ocr", "/ocr"],
  ["/api/organize", "/organize"],
  ["/api/fill-mv82", "/fill-mv82"],
  ["/api/save-extraction", "/save-extraction"],
]);

if (!backendUrl || !backendAudience) {
  throw new Error("OCR_BACKEND_URL and OCR_BACKEND_AUDIENCE are required");
}

let cachedIdentityToken = "";
let cachedIdentityTokenExpiresAt = 0;

const identityToken = async () => {
  if (cachedIdentityToken && Date.now() < cachedIdentityTokenExpiresAt - 60_000) {
    return cachedIdentityToken;
  }
  const tokenUrl = new URL(
    "/computeMetadata/v1/instance/service-accounts/default/identity",
    "http://metadata.google.internal",
  );
  tokenUrl.searchParams.set("audience", backendAudience);
  tokenUrl.searchParams.set("format", "full");
  const response = await fetch(tokenUrl, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`Unable to obtain backend identity token (${response.status})`);
  cachedIdentityToken = await response.text();
  const payload = JSON.parse(Buffer.from(cachedIdentityToken.split(".")[1], "base64url").toString("utf8"));
  cachedIdentityTokenExpiresAt = Number(payload.exp || 0) * 1000;
  return cachedIdentityToken;
};

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  let length = 0;
  request.on("data", (chunk) => {
    length += chunk.length;
    if (length > maxRequestBytes) {
      reject(new Error("Request is too large"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => resolve(Buffer.concat(chunks)));
  request.on("error", reject);
});

const proxyApi = async (request, response, upstreamPath) => {
  try {
    const body = await readBody(request);
    const token = await identityToken();
    const upstream = await fetch(new URL(upstreamPath, backendUrl), {
      method: request.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": request.headers["content-type"] || "application/json",
      },
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(900_000),
    });
    const result = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Content-Length": result.length,
    });
    response.end(result);
  } catch (error) {
    console.error(`Backend proxy failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    const result = Buffer.from(JSON.stringify({ error: "The OCR service is temporarily unavailable" }));
    response.writeHead(502, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": result.length,
    });
    response.end(result);
  }
};

const proxyFrontend = (request, response) => {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: appPort,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${appPort}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Frontend is starting. Please retry shortly.");
  });
  request.pipe(upstream);
};

const frontend = spawn("npm", ["run", "start", "--", "--port", String(appPort)], {
  env: { ...process.env, PORT: String(appPort) },
  stdio: "inherit",
});
frontend.on("exit", (code) => {
  console.error(`Frontend process exited with code ${code}`);
  process.exit(code || 1);
});

const server = http.createServer((request, response) => {
  const path = new URL(request.url || "/", "http://localhost").pathname;
  if (request.method === "GET" && path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end('{"ok":true}');
    return;
  }
  const upstreamPath = apiRoutes.get(path);
  if (upstreamPath) {
    void proxyApi(request, response, upstreamPath);
    return;
  }
  proxyFrontend(request, response);
});

const waitForFrontend = async () => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Frontend process did not become ready within 30 seconds");
};

await waitForFrontend();
server.listen(port, host, () => {
  console.log(`OCR frontend gateway listening at http://${host}:${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  frontend.kill("SIGTERM");
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
