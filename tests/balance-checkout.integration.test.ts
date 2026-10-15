import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localDatabase, seedTestDatabase, CUSTOMER_A, CUSTOMER_B, ADDRESS_A, PRODUCT_A } from "./support/database";
import { issueBalanceCheckout, issueCheckoutPayment, applyBalancePurchase } from "@/lib/commerce/checkout";
import { syncCustomerDepositNotifications, type BalancePurchase, type DepositClaim } from "@/lib/commerce/customer-finance";

beforeEach(seedTestDatabase);
const db = localDatabase();
async function prepare() {
  const cart = await db.rpc("commerce_mutate_cart", { p_customer_id: CUSTOMER_A, p_lines: [{ productId: PRODUCT_A, quantity: 2 }], p_mode: "set", p_operation_id: randomUUID() });
  assert.equal(cart.error, null);
  const args = { p_customer_id: CUSTOMER_A, p_address_id: ADDRESS_A, p_cart_version: cart.data.version,
    p_expected_subtotal_cents: 2000, p_origin: "website", p_conversation_id: null,
    p_payment_method: "account_balance", p_finance_environment: "STAGE",
    p_balance_consent: { account_revision: 7, projected_balance_cents: -1000 } };
  const results = await Promise.all([db.rpc("commerce_prepare_checkout", args), db.rpc("commerce_prepare_checkout", args)]);
  for (const result of results) assert.equal(result.error, null);
  assert.equal(results[0].data.order_id, results[1].data.order_id);
  return results[0].data as { id: string; order_id: string; idempotency_key: string };
}
function decision(orderId: string, status: BalancePurchase["status"] = "PENDING", version = 1): BalancePurchase {
  return { id: "90000000-0000-4000-8000-000000000001", external_order_id: orderId, external_customer_id: CUSTOMER_A,
    environment: "STAGE", customer_id: 1, status, version, amount_cents: 2000, reserved_cents: status === "PENDING" ? 1000 : 0,
    projected_balance_cents: -1000, cash_applied_cents: 1000, core_order_id: null, requires_approval: true };
}
test("balance checkout reuses one order and intent and never claims or issues a Cora invoice", async () => {
  const intent = await prepare();
  const count = await db.from("orders").select("id", { count: "exact" });
  assert.equal(count.count, 1);
  const claim = await db.rpc("commerce_claim_checkout", { p_intent_id: intent.id, p_token: randomUUID() });
  assert.equal(claim.error, null); assert.equal(claim.data?.id ?? null, null);
  await assert.rejects(issueCheckoutPayment(intent.id, db, async () => { throw new Error("must not call Cora"); }), /usa saldo/);
  const payments = await db.from("order_payments").select("id", { count: "exact" });
  assert.equal(payments.count, 0);
});
test("core request carries trusted immutable item prices and exact customer consent", async () => {
  const intent = await prepare();
  let received: Record<string, unknown> | undefined;
  const fakeRequest = async <T>(_path: string, body?: unknown): Promise<T> => {
    received = body as Record<string, unknown>; return decision(intent.order_id) as T;
  };
  await issueBalanceCheckout(intent.id, db, fakeRequest);
  assert.equal(received?.external_order_id, intent.order_id);
  assert.equal(received?.idempotency_key, intent.idempotency_key);
  assert.equal(received?.expected_account_revision, 7);
  assert.equal(received?.expected_projected_balance_cents, -1000);
  assert.deepEqual((received?.order_snapshot as { items: unknown[] }).items, [
    { name: "Bojo de teste", quantity: 2, unit_price_cents: 1000, product_id: 991 }
  ]);
  const row = await db.from("orders").select("status,balance_debt_cents").eq("id", intent.order_id).single();
  assert.equal(row.data?.status, "awaiting_balance_approval");
  assert.equal(row.data?.balance_debt_cents, 0);
});
test("approval records debt rather than a fake paid status; later cancellation is applied exactly once", async () => {
  const intent = await prepare();
  const pending = decision(intent.order_id);
  await applyBalancePurchase(intent.id, pending, db);
  await applyBalancePurchase(intent.id, { ...pending, status: "APPROVED", version: 2 }, db);
  let row = await db.from("orders").select("status,balance_debt_cents").eq("id", intent.order_id).single();
  assert.equal(row.data?.status, "balance_approved"); assert.equal(row.data?.balance_debt_cents, 1000);
  await applyBalancePurchase(intent.id, pending, db);
  row = await db.from("orders").select("status,balance_debt_cents").eq("id", intent.order_id).single();
  assert.equal(row.data?.status, "balance_approved");
  const cancelled = { ...pending, status: "CANCELLED" as const, version: 3 };
  await applyBalancePurchase(intent.id, cancelled, db);
  await applyBalancePurchase(intent.id, cancelled, db);
  await applyBalancePurchase(intent.id, { ...pending, status: "APPROVED", version: 2 }, db);
  row = await db.from("orders").select("status,balance_debt_cents").eq("id", intent.order_id).single();
  assert.equal(row.data?.status, "balance_cancelled"); assert.equal(row.data?.balance_debt_cents, 0);
  const events = await db.from("commerce_notification_events").select("event").eq("order_id", intent.order_id);
  assert.deepEqual(events.data?.map((row) => row.event).sort(), ["balance_approved", "balance_cancelled", "balance_pending"]);
  const payments = await db.from("order_payments").select("id", { count: "exact" }); assert.equal(payments.count, 0);
});
test("wrong environment, customer, order and amount cannot acknowledge a core purchase", async () => {
  const intent = await prepare(); const purchase = decision(intent.order_id);
  for (const patch of [{ environment: "PRODUCTION" }, { external_customer_id: CUSTOMER_B }, { external_order_id: randomUUID() }, { amount_cents: 1 }]) {
    const result = await db.rpc("commerce_apply_balance_purchase", { p_intent_id: intent.id, p_purchase: { ...purchase, ...patch } });
    assert.match(result.error?.message ?? "", /INVALID_BALANCE_PURCHASE/);
  }
  const ownDb = localDatabase("authenticated", CUSTOMER_A);
  const direct = await ownDb.rpc("commerce_apply_balance_purchase", { p_intent_id: intent.id, p_purchase: purchase });
  assert.ok(direct.error);
});
test("worse account projection persists a review state and does not silently accept the new debt", async () => {
  const intent = await prepare();
  const fakeRequest = async <T>(): Promise<T> => { throw Object.assign(new Error("Changed"), { code: "ACCOUNT_CHANGED" }); };
  await assert.rejects(issueBalanceCheckout(intent.id, db, fakeRequest), /Changed/);
  const row = await db.from("checkout_intents").select("status,finance_consent,core_purchase_id").eq("id", intent.id).single();
  assert.equal(row.data?.status, "balance_review"); assert.equal(row.data?.core_purchase_id, null);
  assert.equal(row.data?.finance_consent.projected_balance_cents, -1000);
});
test("WhatsApp approval notices stay durable, deduplicated and bound to the linked customer", async () => {
  const intent = await prepare();
  const contact = await db.from("whatsapp_contacts").insert({ provider: "evolution", account: "local-fake", wa_id: "5511999900000", customer_id: CUSTOMER_A }).select("id").single();
  assert.equal(contact.error, null);
  const conversation = await db.from("whatsapp_conversations").insert({ contact_id: contact.data!.id }).select("id").single();
  assert.equal(conversation.error, null);
  await applyBalancePurchase(intent.id, decision(intent.order_id, "APPROVED", 2), db);
  const event = await db.rpc("commerce_claim_notification", { p_token: randomUUID(), p_account: "local-fake" });
  assert.equal(event.error, null); assert.equal(event.data.event, "balance_approved");
  const outbox = await db.from("whatsapp_outbox").select("content");
  assert.equal(outbox.data?.length, 1);
  assert.match(outbox.data![0].content.text, /Dívida deste pedido: R\$ 10,00/);
  assert.doesNotMatch(outbox.data![0].content.text, /Pagamento confirmado pela Cora/);
  assert.equal(outbox.data![0].content.customerId, CUSTOMER_A);
});
test("catalog edits after a timeout do not change the persisted financial request snapshot", async () => {
  const intent = await prepare();
  const requests: unknown[] = [];
  const fakeRequest = async <T>(_path: string, body?: unknown): Promise<T> => {
    requests.push(body); return decision(intent.order_id) as T;
  };
  await issueBalanceCheckout(intent.id, db, fakeRequest);
  const changed = await db.from("product_marketplace_config").update({ display_title: "Renamed later", factory_product_id: 111111 }).eq("id", PRODUCT_A);
  assert.equal(changed.error, null);
  await issueBalanceCheckout(intent.id, db, fakeRequest);
  assert.deepEqual(requests[0], requests[1]);
});
test("new core receipt versions update debt and factory reference without regressing fulfilment", async () => {
  const intent = await prepare();
  await applyBalancePurchase(intent.id, decision(intent.order_id, "APPROVED", 1), db);
  const registered = await db.from("orders").update({ status: "in_production" }).eq("id", intent.order_id);
  assert.equal(registered.error, null);
  await applyBalancePurchase(intent.id, { ...decision(intent.order_id, "APPROVED", 2), cash_applied_cents: 2000, core_order_id: 42 }, db);
  const fresh = await db.from("orders").select("status,balance_debt_cents,factory_order_id").eq("id", intent.order_id).single();
  assert.equal(fresh.data?.status, "in_production"); assert.equal(fresh.data?.balance_debt_cents, 0); assert.equal(fresh.data?.factory_order_id, 42);
});
test("authenticated deposit credit queues one customer-bound notification without creating financial postings in Supabase", async () => {
  const deposit: DepositClaim = { id: randomUUID(), external_customer_id: CUSTOMER_A, environment: "STAGE", amount_cents: 30000,
    kind: "BOLETO", status: "OPEN", boleto_url: null, digitable: null };
  const remembered = await db.rpc("commerce_remember_customer_deposit", { p_customer_id: CUSTOMER_A, p_deposit: deposit });
  assert.equal(remembered.error, null);
  const contact = await db.from("whatsapp_contacts").insert({ provider: "evolution", account: "local-fake", wa_id: "5511999900000", customer_id: CUSTOMER_A }).select("id").single();
  assert.equal(contact.error, null);
  await db.from("whatsapp_conversations").insert({ contact_id: contact.data!.id });
  const requests: string[] = [];
  const fake = async <T>(path: string): Promise<T> => { requests.push(path); return { ...deposit, status: path.endsWith("/sync") ? "CREDITED" : "OPEN" } as T; };
  await syncCustomerDepositNotifications(db, "local-fake", fake);
  assert.equal(requests.length, 2);
  const notices = await db.from("whatsapp_outbox").select("content");
  assert.equal(notices.data?.length, 1); assert.equal(notices.data![0].content.customerId, CUSTOMER_A);
  assert.match(notices.data![0].content.text, /Recebimento confirmado no banco: R\$ 300,00/);
  assert.match(notices.data![0].content.text, /Ambiente de teste/);
  await Promise.all([db.rpc("commerce_notify_customer_deposit", { p_customer_id: CUSTOMER_A, p_deposit: { ...deposit, status: "CREDITED" }, p_account: "local-fake" }),
    db.rpc("commerce_notify_customer_deposit", { p_customer_id: CUSTOMER_A, p_deposit: { ...deposit, status: "CREDITED" }, p_account: "local-fake" })]);
  const total = await db.from("whatsapp_outbox").select("id", { count: "exact" }); assert.equal(total.count, 1);
  const orders = await db.from("orders").select("id", { count: "exact" }); assert.equal(orders.count, 0);
  const payments = await db.from("order_payments").select("id", { count: "exact" }); assert.equal(payments.count, 0);
});
test("deposit notification references reject another customer and browser-side confirmation", async () => {
  const deposit = { id: randomUUID(), external_customer_id: CUSTOMER_B, environment: "STAGE", amount_cents: 30000, status: "CREDITED" };
  const wrong = await db.rpc("commerce_remember_customer_deposit", { p_customer_id: CUSTOMER_A, p_deposit: deposit });
  assert.match(wrong.error?.message ?? "", /INVALID_DEPOSIT_REFERENCE/);
  const own = localDatabase("authenticated", CUSTOMER_A);
  const unauthenticated = await own.rpc("commerce_notify_customer_deposit", { p_customer_id: CUSTOMER_A,
    p_deposit: { ...deposit, external_customer_id: CUSTOMER_A }, p_account: "local-fake" });
  assert.ok(unauthenticated.error);
});
