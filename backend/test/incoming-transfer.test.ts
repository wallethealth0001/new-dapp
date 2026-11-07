import assert from "node:assert/strict";
import test from "node:test";
import {
  findActiveApprovalAt,
  isIncomingTransferInScope,
  Store,
  type ApprovalRecord,
  type IncomingTransferRecord
} from "../src/store";
import { incomingTransferConfirmationState, WalletMonitor } from "../src/monitor";
import { config } from "../src/config";

const wallet = "0x00000000000000000000000000000000000000aa";
const otherWallet = "0x00000000000000000000000000000000000000bb";
const transactionHash = `0x${"12".repeat(32)}`;
const approvalHash = `0x${"34".repeat(32)}`;

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: `approval-${config.USDT_ADDRESS.toLowerCase()}-${approvalHash}-1`,
    walletAddress: wallet,
    ownerAddress: wallet,
    spender: config.ALLOWANCE_SPENDER_ADDRESS,
    tokenContract: config.USDT_ADDRESS,
    tokenSymbol: "USDT",
    tokenDecimals: 18,
    approvalAmount: "100",
    rawApprovalAmount: "100000000000000000000",
    network: config.NETWORK_NAME,
    chainId: String(config.CHAIN_ID),
    blockNumber: 100,
    blockTimestamp: "2026-01-01T00:00:00.000Z",
    transactionHash: approvalHash,
    logIndex: 1,
    eventType: "Approval",
    processingStatus: "processed",
    telegramStatus: "sent",
    telegramAttemptCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canonicalStatus: "canonical",
    ...overrides
  };
}

function incoming(
  approvalRecord: ApprovalRecord,
  overrides: Partial<IncomingTransferRecord> = {}
): IncomingTransferRecord {
  return {
    id: `incoming-${config.CHAIN_ID}-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash}-2`,
    walletAddress: wallet,
    sender: otherWallet,
    receivedAmount: "1",
    rawReceivedAmount: "1000000000000000000",
    tokenContract: config.USDT_ADDRESS,
    tokenSymbol: "USDT",
    tokenDecimals: 18,
    spender: config.ALLOWANCE_SPENDER_ADDRESS,
    approvalRecordId: approvalRecord.id,
    approvalTransactionHash: approvalRecord.transactionHash,
    approvalBlockNumber: approvalRecord.blockNumber,
    approvalBlockTimestamp: approvalRecord.blockTimestamp,
    approvedAllowance: approvalRecord.approvalAmount,
    rawApprovedAllowance: approvalRecord.rawApprovalAmount,
    balanceStatus: "verified",
    network: config.NETWORK_NAME,
    chainId: String(config.CHAIN_ID),
    blockNumber: 120,
    blockHash: `0x${"56".repeat(32)}`,
    transactionIndex: 0,
    blockTimestamp: "2026-01-01T00:10:00.000Z",
    blockTimestampStatus: "verified",
    transactionHash,
    logIndex: 2,
    eventType: "IncomingTransfer",
    processingStatus: "processed",
    canonicalStatus: "canonical",
    confirmationStatus: "pending",
    confirmations: 1,
    telegramStatus: "pending",
    telegramAttemptCount: 0,
    createdAt: "2026-01-01T00:10:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    ...overrides
  };
}

test("accepts incoming-transfer associations using either historical approval ID format", () => {
  for (const id of [
    `approval-56-${config.USDT_ADDRESS.toLowerCase()}-${approvalHash}-1`,
    `approval-${config.USDT_ADDRESS.toLowerCase()}-${approvalHash}-1`
  ]) {
    const record = approval({ id });
    assert.equal(isIncomingTransferInScope(incoming(record), [record]), true);
  }
});

test("reuses a historical approval row when the same transaction is rescanned", async () => {
  const legacyRecord = approval({
    id: `approval-${config.USDT_ADDRESS.toLowerCase()}-${approvalHash}-1`
  });
  const canonicalRecord = approval({
    id: `approval-${config.CHAIN_ID}-${config.USDT_ADDRESS.toLowerCase()}-${approvalHash}-1`
  });
  const store = new Store();
  Reflect.set(store, "approvalEvents", [legacyRecord, canonicalRecord]);
  Reflect.set(store, "persist", async () => {});
  const found = await store.findApprovalEvent(String(config.CHAIN_ID), approvalHash, 1);
  assert.equal(found?.id, canonicalRecord.id);
  assert.equal(findActiveApprovalAt([legacyRecord, canonicalRecord], wallet, 101, 0)?.id, canonicalRecord.id);
  await store.upsertApproval(canonicalRecord);
  assert.deepEqual(store.listApprovalEvents().map(record => record.approvalStatus), ["active", "active"]);
  assert.equal(store.listApprovalEvents().length, 2);
});

test("requires the referenced approval to be the latest positive approval before the transfer", () => {
  const grant = approval();
  const revoke = approval({
    id: `approval-56-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash}-3`,
    rawApprovalAmount: "0",
    approvalAmount: "0",
    blockNumber: 110,
    logIndex: 3,
    transactionHash,
    approvalStatus: "revoked"
  });
  const reapproval = approval({
    id: `approval-56-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash}-4`,
    blockNumber: 115,
    logIndex: 4,
    transactionHash
  });

  assert.equal(isIncomingTransferInScope(incoming(grant, { blockNumber: 109 }), [grant, revoke]), true);
  assert.equal(isIncomingTransferInScope(incoming(grant, { blockNumber: 111 }), [grant, revoke]), false);
  assert.equal(isIncomingTransferInScope(incoming(revoke, { blockNumber: 111 }), [grant, revoke]), false);
  assert.equal(isIncomingTransferInScope(incoming(reapproval, { blockNumber: 116 }), [grant, revoke, reapproval]), true);
  assert.equal(isIncomingTransferInScope(incoming(reapproval, { blockNumber: 115, logIndex: 3 }), [reapproval]), false);
});

test("rejects associations with a different wallet, spender, token, or chain", () => {
  const record = approval();
  assert.equal(isIncomingTransferInScope(incoming(record, { walletAddress: otherWallet }), [record]), false);
  assert.equal(isIncomingTransferInScope(incoming(record, { spender: otherWallet }), [record]), false);
  assert.equal(isIncomingTransferInScope(incoming(record, { tokenContract: otherWallet }), [record]), false);
  assert.equal(isIncomingTransferInScope(incoming(record, { chainId: "97" }), [record]), false);
  assert.equal(isIncomingTransferInScope(incoming(record), [approval({ spender: otherWallet })]), false);
  assert.equal(isIncomingTransferInScope(incoming(record), [approval({ tokenContract: otherWallet })]), false);
  assert.equal(isIncomingTransferInScope(incoming(record), [approval({ chainId: "97" })]), false);
});

test("finds the active approval at the transfer's exact block and log position", () => {
  const grant = approval();
  const revoke = approval({
    rawApprovalAmount: "0",
    approvalAmount: "0",
    blockNumber: 120,
    logIndex: 3,
    transactionHash,
    id: `approval-56-${config.USDT_ADDRESS.toLowerCase()}-${transactionHash}-3`
  });
  assert.equal(findActiveApprovalAt([grant, revoke], wallet, 120, 2)?.id, grant.id);
  assert.equal(findActiveApprovalAt([grant, revoke], wallet, 120, 4), undefined);
  assert.equal(findActiveApprovalAt([grant], otherWallet, 121, 0), undefined);
});

test("requires 15 confirmations and the canonical block hash for incoming delivery", () => {
  const event = incoming(approval());
  const canonicalHash = event.blockHash;
  assert.deepEqual(incomingTransferConfirmationState(event, event.blockNumber + 12, canonicalHash), {
    confirmations: 13,
    confirmationStatus: "pending",
    eligible: false
  });
  assert.deepEqual(incomingTransferConfirmationState(event, event.blockNumber + 13, canonicalHash), {
    confirmations: 14,
    confirmationStatus: "pending",
    eligible: false
  });
  assert.deepEqual(incomingTransferConfirmationState(event, event.blockNumber + 14, canonicalHash), {
    confirmations: 15,
    confirmationStatus: "confirmed",
    eligible: true
  });
  assert.equal(incomingTransferConfirmationState(event, event.blockNumber + 20, `0x${"ab".repeat(32)}`), undefined);
  assert.equal(incomingTransferConfirmationState({ ...event, canonicalStatus: "reorged" }, 200, canonicalHash), undefined);
});

test("the dispatcher makes no Telegram request before 15 confirmations and sends at 15", async () => {
  const approvalRecord = approval();
  const event = incoming(approvalRecord);
  const store = new Store();
  Reflect.set(store, "approvalEvents", [approvalRecord]);
  let saved = event;
  let claimCount = 0;
  let finishStatus: string | undefined;
  Reflect.set(store, "upsertIncomingTransfer", async (record: IncomingTransferRecord) => {
    saved = record;
    return record;
  });
  Reflect.set(store, "claimIncomingTelegramNotification", async () => {
    claimCount += 1;
    return { status: "claimed", leaseToken: "mock-lease-token" };
  });
  Reflect.set(store, "finishIncomingTelegramNotification", async (_id: string, _token: string, status: string) => {
    finishStatus = status;
    return true;
  });

  const monitor = new WalletMonitor(store);
  let latestBlock = event.blockNumber + 13;
  Reflect.set(monitor, "provider", {
    getBlockNumber: async () => latestBlock,
    getBlock: async () => ({ hash: event.blockHash })
  });
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 1, chat: { id: config.TELEGRAM_CHAT_ID } }
    }), { status: 200 });
  };

  try {
    const sendIncoming = Reflect.get(monitor, "sendIncomingTransferNotification");
    await Reflect.apply(sendIncoming, monitor, [event]);
    assert.equal(requestCount, 0);
    assert.equal(claimCount, 0);
    assert.equal(saved.confirmations, 14);
    assert.equal(saved.confirmationStatus, "pending");

    latestBlock += 1;
    await Reflect.apply(sendIncoming, monitor, [saved]);
    assert.equal(requestCount, 1);
    assert.equal(claimCount, 1);
    assert.equal(saved.confirmations, 15);
    assert.equal(saved.confirmationStatus, "confirmed");
    assert.equal(saved.telegramStatus, "sent");
    assert.equal(finishStatus, "sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("records Telegram API failures and retries without exceeding 15-confirmation gating", async () => {
  const approvalRecord = approval();
  const event = incoming(approvalRecord, {
    blockNumber: 120,
    confirmations: 14,
    confirmationStatus: "pending"
  });
  const store = new Store();
  Reflect.set(store, "approvalEvents", [approvalRecord]);
  let saved = event;
  let claimCount = 0;
  const finishStatuses: string[] = [];
  Reflect.set(store, "upsertIncomingTransfer", async (record: IncomingTransferRecord) => {
    saved = record;
    return record;
  });
  Reflect.set(store, "claimIncomingTelegramNotification", async () => {
    claimCount += 1;
    return { status: "claimed", leaseToken: `mock-lease-${claimCount}` };
  });
  Reflect.set(store, "finishIncomingTelegramNotification", async (_id: string, _token: string, status: string) => {
    finishStatuses.push(status);
    return true;
  });

  const monitor = new WalletMonitor(store);
  Reflect.set(monitor, "provider", {
    getBlockNumber: async () => event.blockNumber + 14,
    getBlock: async () => ({ hash: event.blockHash })
  });
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ ok: false, description: "mock Telegram rate limit" }), { status: 429 });
    }
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 2, chat: { id: config.TELEGRAM_CHAT_ID } }
    }), { status: 200 });
  };

  try {
    const sendIncoming = Reflect.get(monitor, "sendIncomingTransferNotification");
    await Reflect.apply(sendIncoming, monitor, [event]);
    assert.equal(requestCount, 1);
    assert.equal(saved.telegramStatus, "failed");
    assert.equal(saved.telegramAttemptCount, 1);
    assert.match(saved.telegramError || "", /mock Telegram rate limit/);

    await Reflect.apply(sendIncoming, monitor, [saved]);
    assert.equal(requestCount, 2);
    assert.equal(saved.telegramStatus, "sent");
    assert.equal(saved.telegramAttemptCount, 2);
    assert.deepEqual(finishStatuses, ["failed", "sent"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
