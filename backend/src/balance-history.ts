export type BalanceTransferLog = {
  key: string;
  transactionIndex: number;
  logIndex: number;
  from: string;
  to: string;
  amount: bigint;
};

export type ReconstructedBalanceChange = {
  before: bigint;
  after: bigint;
};

export function reconstructWalletBalanceTimeline(
  walletAddress: string,
  initialBalance: bigint,
  transferLogs: BalanceTransferLog[],
  expectedEndBalance: bigint
) {
  if (initialBalance < 0n || expectedEndBalance < 0n) {
    throw new Error("Historical wallet balances cannot be negative");
  }
  const wallet = walletAddress.toLowerCase();
  let balance = initialBalance;
  const timeline = new Map<string, ReconstructedBalanceChange>();
  const orderedLogs = transferLogs.slice().sort((first, second) =>
    first.transactionIndex - second.transactionIndex || first.logIndex - second.logIndex
  );

  for (const log of orderedLogs) {
    if (log.amount < 0n) throw new Error("USDT transfer amounts cannot be negative");
    const from = log.from.toLowerCase();
    const to = log.to.toLowerCase();
    const before = balance;
    if (from === wallet) balance -= log.amount;
    if (to === wallet) balance += log.amount;
    if (balance < 0n) throw new Error(`Transfer reconstruction produced a negative balance for ${walletAddress}`);
    if (to === wallet) timeline.set(log.key, { before, after: balance });
  }

  if (balance !== expectedEndBalance) {
    throw new Error(
      `Reconstructed block-end balance ${balance} does not match historical balance ${expectedEndBalance}`
    );
  }
  return timeline;
}
