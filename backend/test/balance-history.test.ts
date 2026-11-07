import assert from "node:assert/strict";
import test from "node:test";
import { reconstructWalletBalanceTimeline } from "../src/balance-history";

const wallet = "0x00000000000000000000000000000000000000aa";
const outside = "0x00000000000000000000000000000000000000bb";

test("reconstructs incoming and outgoing transfer events in block log order", () => {
  const timeline = reconstructWalletBalanceTimeline(wallet, 100n, [
    { key: "tx3:8", transactionIndex: 3, logIndex: 8, from: wallet, to: outside, amount: 5n },
    { key: "tx1:3", transactionIndex: 1, logIndex: 3, from: wallet, to: outside, amount: 40n },
    { key: "tx2:7", transactionIndex: 2, logIndex: 7, from: outside, to: wallet, amount: 10n },
    { key: "tx1:2", transactionIndex: 1, logIndex: 2, from: outside, to: wallet, amount: 25n },
    { key: "tx2:6", transactionIndex: 2, logIndex: 6, from: wallet, to: wallet, amount: 5n }
  ], 90n);

  assert.deepEqual(timeline.get("tx1:2"), { before: 100n, after: 125n });
  assert.deepEqual(timeline.get("tx2:7"), { before: 85n, after: 95n });
  assert.deepEqual(timeline.get("tx2:6"), { before: 85n, after: 85n });
  assert.equal(timeline.has("tx1:3"), false);
});

test("rejects a reconstruction that does not match the historical block-end balance", () => {
  assert.throws(() => reconstructWalletBalanceTimeline(wallet, 100n, [
    { key: "tx1:1", transactionIndex: 1, logIndex: 1, from: outside, to: wallet, amount: 25n }
  ], 126n), /does not match historical balance/);
});

test("rejects an impossible debit instead of producing a negative historical balance", () => {
  assert.throws(() => reconstructWalletBalanceTimeline(wallet, 10n, [
    { key: "tx1:1", transactionIndex: 1, logIndex: 1, from: wallet, to: outside, amount: 11n }
  ], 0n), /negative balance/);
});
