import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/store";

type DeliveryRow = { id: string; record: Record<string, unknown>; created_at: string };

class FakeSupabaseQuery {
  private operation: "select" | "insert" | "update" | "upsert" = "select";
  private values: Record<string, unknown> | undefined;
  private readonly filters: Array<{ column: string; operator: "eq" | "lt" | "is"; value: unknown }> = [];
  private columns = "";
  private single = false;

  constructor(private readonly rows: Map<string, DeliveryRow>) {}

  select(columns: string) {
    this.columns = columns;
    return this;
  }

  insert(values: DeliveryRow) {
    this.operation = "insert";
    this.values = { ...values };
    return this;
  }

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  upsert(values: DeliveryRow) {
    this.operation = "upsert";
    this.values = { ...values };
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: "eq", value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ column, operator: "lt", value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, operator: "is", value });
    return this;
  }

  returns<T>(): this {
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  then<TResult1 = { data: unknown; error: { code?: string; message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { code?: string; message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute() {
    if (this.operation === "insert" || this.operation === "upsert") {
      const row: DeliveryRow = {
        id: String(this.values?.id),
        record: this.values?.record as Record<string, unknown>,
        created_at: String(this.values?.created_at)
      };
      if (this.operation === "insert" && this.rows.has(row.id)) {
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      this.rows.set(row.id, row);
      return { data: null, error: null };
    }

    const matches = [...this.rows.values()].filter((row) =>
      this.filters.every(({ column, operator, value }) => {
        const actual = column.startsWith("record->>")
          ? row.record[column.slice("record->>".length)]
          : column === "id" ? row.id : undefined;
        if (operator === "is") return value === null ? actual === null || actual === undefined : actual === value;
        if (operator === "eq") return actual === value;
        return typeof actual === "string" && typeof value === "string" && actual < value;
      })
    );

    if (this.operation === "update") {
      for (const row of matches) {
        const updatedRecord = (this.values?.record ?? {}) as Record<string, unknown>;
        row.record = updatedRecord;
      }
    }
    const data = this.operation === "select" && this.columns === "record"
      ? matches.map((row) => ({ record: row.record }))
      : matches;
    return {
      data: this.single && Array.isArray(data) ? data[0] ?? null : data,
      error: null
    };
  }
}

function createStore(rows: Map<string, DeliveryRow>) {
  const store = new Store();
  Reflect.set(store, "client", {
    from: () => new FakeSupabaseQuery(rows)
  });
  return store;
}

test("claims are exclusive, retries recover after lease expiry, and sent deliveries stay terminal", async () => {
  const rows = new Map<string, DeliveryRow>();
  const store = createStore(rows);
  const [first, competing] = await Promise.all([
    store.claimIncomingTelegramNotification("event-1", 20),
    store.claimIncomingTelegramNotification("event-1", 20)
  ]);
  assert.equal([first, competing].filter((claim) => claim?.status === "claimed").length, 1);
  assert.equal([first, competing].filter((claim) => claim === undefined).length, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const retry = await store.claimIncomingTelegramNotification("event-1", 20);
  assert.equal(retry?.status, "claimed");
  if (retry?.status !== "claimed") return;
  assert.equal(await store.finishIncomingTelegramNotification(
    "event-1",
    retry.leaseToken,
    "sent",
    { sentAt: new Date().toISOString() },
    20
  ), true);
  assert.deepEqual(await store.claimIncomingTelegramNotification("event-1", 20), {
    status: "sent",
    sentAt: rows.get("event-1")?.record.sentAt
  });
});

test("reclaims stale legacy delivery claims without changing the table schema", async () => {
  const oldClaim = new Date(Date.now() - 60_000).toISOString();
  const rows = new Map<string, DeliveryRow>([[
    "legacy-event",
    {
      id: "legacy-event",
      record: { eventId: "legacy-event", claimedAt: oldClaim },
      created_at: oldClaim
    }
  ]]);
  const store = createStore(rows);
  const claim = await store.claimIncomingTelegramNotification("legacy-event", 100);
  assert.equal(claim?.status, "claimed");
});

test("failed sends cannot be retried until the failed delivery lease expires", async () => {
  const rows = new Map<string, DeliveryRow>();
  const store = createStore(rows);
  const claim = await store.claimIncomingTelegramNotification("failed-event", 20);
  assert.equal(claim?.status, "claimed");
  if (claim?.status !== "claimed") return;

  assert.equal(await store.finishIncomingTelegramNotification(
    "failed-event",
    claim.leaseToken,
    "failed",
    { error: "mock Telegram rejection" },
    20
  ), true);
  assert.equal(await store.claimIncomingTelegramNotification("failed-event", 20), undefined);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await store.claimIncomingTelegramNotification("failed-event", 20))?.status, "claimed");
});
