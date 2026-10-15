import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ADDRESS_A, CUSTOMER_A, PRODUCT_A, TEST_API_URL, TEST_DATABASE_URL,
  localDatabase, localToken, seedTestDatabase
} from "./support/database";
import {
  getCustomerBalance, createBalanceDeposit, financeRequest,
  type BalancePurchase
} from "@/lib/commerce/customer-finance";
import {
  prepareCheckout, issueBalanceCheckout, issueCheckoutPayment,
  syncBalanceCheckout, renewBalanceConsent, applyBalancePurchase
} from "@/lib/commerce/checkout";
import { processConversation } from "@/lib/whatsapp/engine";
import { SupabaseBotServices } from "@/lib/whatsapp/repository";
import type { BotState } from "@/lib/whatsapp/types";

const coreDatabase = process.env.PONTALTI_FINANCE_E2E_DATABASE_URL;
if (!coreDatabase) throw new Error("PONTALTI_FINANCE_E2E_DATABASE_URL_REQUIRED");
const parsed = new URL(coreDatabase);
if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/pontalti_finance_e2e_test")
  throw new Error("ISOLATED_CORE_FINANCE_DATABASE_REQUIRED");
if (new URL(TEST_DATABASE_URL).port !== "55449" || new URL(TEST_API_URL).port !== "55450")
  throw new Error("ISOLATED_SUPABASE_FINANCE_PORTS_REQUIRED");
const port = Number(process.env.PONTALTI_FINANCE_TEST_PORT ?? "35511");
const coreOrigin = `http://127.0.0.1:${port}`;
const token = "pontalti-customer-finance-e2e-private-test-token-only";
process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = localToken();
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3002";
process.env.CORE_API_URL = coreOrigin + "/api/v1";
process.env.CUSTOMER_FINANCE_INTERNAL_TOKEN = token;
process.env.CUSTOMER_FINANCE_ENVIRONMENT = "PRODUCTION";
const db = localDatabase();
let child: ChildProcess;
let childLog = "";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(coreOrigin + path, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${data.message}`);
  return data;
}
const admin = (path: string, method = "GET", body?: unknown) => request("/api/v1/customer-finance" + path, method, body);
const state = () => request("/__test/state");
async function approveIdentity() {
  await assert.rejects(() => getCustomerBalance(CUSTOMER_A, db), /vínculo/);
  const links = await admin("/links?environment=PRODUCTION&status=PENDING");
  assert.equal(links.length, 1);
  await admin(`/links/${links[0].id}/approve`, "POST", { version: links[0].version, reason: "Identidade conferida no cenário de testes" });
}
async function fund(amount = 10000) {
  await request("/__test/fund", "POST", { external_customer_id: CUSTOMER_A, amount_cents: amount });
}
async function checkout(quantity = 15, consent?: { account_revision: number; projected_balance_cents: number }) {
  const balance = await getCustomerBalance(CUSTOMER_A, db);
  const cart = await db.rpc("commerce_mutate_cart", {
    p_customer_id: CUSTOMER_A, p_lines: [{ productId: PRODUCT_A, quantity }],
    p_mode: "increment", p_operation_id: randomUUID()
  });
  assert.equal(cart.error, null);
  const amount = quantity * 1000;
  return prepareCheckout({
    customerId: CUSTOMER_A, addressId: ADDRESS_A, cartVersion: cart.data.version,
    subtotalCents: amount, origin: "website", paymentMethod: "account_balance",
    balanceConsent: consent ?? {
      account_revision: balance.account_revision,
      projected_balance_cents: balance.available_cents - amount
    }
  }, db);
}
async function approve(purchase: BalancePurchase) {
  const fresh = await admin(`/approvals/${purchase.id}`);
  return admin(`/approvals/${purchase.id}/approve`, "POST", {
    version: fresh.version, account_revision: fresh.summary.account_revision,
    reason: "Crédito autorizado no teste integrado"
  }) as Promise<BalancePurchase>;
}

before(async () => {
  child = spawn(process.execPath, [resolve("tests/support/core-finance-test-api.cjs")], {
    env: { ...process.env, PONTALTI_FINANCE_TEST_ONLY: "true", PONTALTI_FINANCE_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (data) => { childLog += data.toString(); });
  child.stderr?.on("data", (data) => { childLog += data.toString(); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Core test API stopped: " + childLog);
    try { if ((await fetch(coreOrigin + "/__test/ready")).ok) return; } catch { /* child loading */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Core test API did not start: " + childLog);
});
after(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await stopped;
  }
});
beforeEach(async () => {
  await request("/__test/reset", "POST");
  await seedTestDatabase();
});

test("cadastro existente exige conferência antes de expor ou gastar o saldo", async () => {
  await approveIdentity();
  const balance = await getCustomerBalance(CUSTOMER_A, db);
  assert.equal(balance.balance_cents, 0);
  const unauthorized = await fetch(coreOrigin + `/api/v1/commerce-finance/customers/${CUSTOMER_A}/summary?environment=PRODUCTION`);
  assert.equal(unauthorized.status, 401);
});

test("boleto individual só credita após confirmação bancária e credita uma única vez", async () => {
  await approveIdentity();
  const deposit = await createBalanceDeposit(CUSTOMER_A, 10000, randomUUID(), db);
  assert.equal(deposit.status, "OPEN");
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).balance_cents, 0);
  const detail = await financeRequest<{ invoice_id: string }>(`/deposits/${deposit.id}?environment=PRODUCTION`);
  await request(`/__test/invoices/${detail.invoice_id}/paid`, "POST");
  await Promise.all([1, 2].map(() => financeRequest(`/deposits/${deposit.id}/sync`, { environment: "PRODUCTION" })));
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).balance_cents, 10000);
  assert.equal((await state()).entries.filter((entry: { kind: string }) => entry.kind === "DEPOSIT").length, 1);
});

test("saldo insuficiente espera aprovação e registra somente a parte recebida como pagamento", async () => {
  await approveIdentity(); await fund();
  const intent = await checkout();
  const purchase = await issueBalanceCheckout(intent.id, db);
  assert.equal(purchase.status, "PENDING");
  assert.equal(purchase.projected_balance_cents, -5000);
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).reserved_cents, 10000);
  assert.equal((await state()).orders.length, 0);
  const replay = await issueBalanceCheckout(intent.id, db);
  assert.equal(replay.id, purchase.id);
  let invoiceCalls = 0;
  await assert.rejects(() => issueCheckoutPayment(intent.id, db, async () => {
    invoiceCalls++; throw new Error("UNEXPECTED_ORDER_INVOICE");
  }), /saldo na conta/);
  assert.equal(invoiceCalls, 0);
  await approve(purchase);
  await syncBalanceCheckout(intent.order_id, CUSTOMER_A, db);
  const order = await db.from("orders").select("status,order_payments(id)").eq("id", intent.order_id).single();
  assert.equal(order.data?.status, "balance_approved");
  assert.equal(order.data?.order_payments.length, 0);
  const approved = await admin(`/approvals/${purchase.id}`);
  const registered = await admin(`/approvals/${purchase.id}/register-order`, "POST", {
    version: approved.version, products: [{ id: 991, quantity: 15, unit_price: 10 }]
  });
  const repeated = await admin(`/approvals/${purchase.id}/register-order`, "POST", {
    version: approved.version, products: [{ id: 991, quantity: 15, unit_price: 10 }]
  });
  assert.equal(repeated.core_order_id, registered.core_order_id);
  const actual = await state();
  assert.equal(actual.orders.length, 1);
  assert.equal(actual.payments.length, 1);
  assert.equal(actual.payments[0].amount_paid, 100);
  assert.equal(actual.payments[0].remaining, 50);
  assert.equal(actual.customers[0].debts, 50);
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).balance_cents, -5000);
  assert.equal((await db.from("orders").update({
    status: "confirmed", factory_order_id: registered.core_order_id
  }).eq("id", intent.order_id)).error, null);
  await fund(15000);
  await syncBalanceCheckout(intent.order_id, CUSTOMER_A, db);
  const settled = await state();
  assert.equal(settled.payments.reduce((sum: number, payment: { amount_paid: number }) => sum + payment.amount_paid, 0), 150);
  assert.equal(settled.payments.at(-1).remaining, 0);
  assert.equal(settled.customers[0].debts, 0);
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).balance_cents, 10000);
  const updatedOrder = await db.from("orders").select("status,balance_debt_cents").eq("id", intent.order_id).single();
  assert.equal(updatedOrder.data?.status, "confirmed");
  assert.equal(updatedOrder.data?.balance_debt_cents, 0);
});

test("recusa libera a reserva sem efetivar dívida", async () => {
  await approveIdentity(); await fund();
  const intent = await checkout(); const purchase = await issueBalanceCheckout(intent.id, db);
  await admin(`/approvals/${purchase.id}/reject`, "POST", { version: purchase.version, reason: "Compra recusada no teste" });
  await syncBalanceCheckout(intent.order_id, CUSTOMER_A, db);
  const balance = await getCustomerBalance(CUSTOMER_A, db);
  assert.equal(balance.balance_cents, 10000); assert.equal(balance.reserved_cents, 0); assert.equal(balance.debts_cents, 0);
  assert.equal((await db.from("orders").select("status").eq("id", intent.order_id).single()).data?.status, "balance_rejected");
});

test("cancelamento após aprovação estorna uma vez e resposta antiga não ressuscita o pedido", async () => {
  await approveIdentity(); await fund();
  const intent = await checkout(); const pending = await issueBalanceCheckout(intent.id, db);
  const approved = await approve(pending); await syncBalanceCheckout(intent.order_id, CUSTOMER_A, db);
  await admin(`/approvals/${approved.id}/cancel`, "POST", { version: approved.version, reason: "Cancelado antes de registrar na fábrica" });
  await syncBalanceCheckout(intent.order_id, CUSTOMER_A, db);
  await applyBalancePurchase(intent.id, approved, db);
  const balance = await getCustomerBalance(CUSTOMER_A, db);
  assert.equal(balance.balance_cents, 10000); assert.equal(balance.debts_cents, 0);
  assert.equal((await db.from("orders").select("status").eq("id", intent.order_id).single()).data?.status, "balance_cancelled");
});

test("mudança de saldo depois do resumo exige nova confirmação do cliente", async () => {
  await approveIdentity(); await fund();
  const old = await getCustomerBalance(CUSTOMER_A, db);
  await fund(1000);
  const intent = await checkout(15, { account_revision: old.account_revision, projected_balance_cents: old.available_cents - 15000 });
  await assert.rejects(() => issueBalanceCheckout(intent.id, db));
  assert.equal((await db.from("checkout_intents").select("status").eq("id", intent.id).single()).data?.status, "balance_review");
  assert.equal((await admin("/approvals?environment=PRODUCTION")).length, 0);
  const latest = await getCustomerBalance(CUSTOMER_A, db);
  const purchase = await renewBalanceConsent(intent.order_id, CUSTOMER_A, {
    account_revision: latest.account_revision, projected_balance_cents: latest.available_cents - 15000
  }, db);
  assert.equal(purchase.status, "PENDING"); assert.equal(purchase.projected_balance_cents, -4000);
});

test("saldo suficiente confirma a compra sem análise de crédito nem cobrança bancária de pedido", async () => {
  await approveIdentity(); await fund(20000);
  const intent = await checkout();
  const purchase = await issueBalanceCheckout(intent.id, db);
  assert.equal(purchase.status, "APPROVED");
  assert.equal(purchase.requires_approval, false);
  assert.equal(purchase.cash_applied_cents, 15000);
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).available_cents, 5000);
  const result = await state();
  assert.equal(result.invoiceCreates, 1); // Only the top-up invoice; no order invoice.
  assert.equal(result.orders.length, 0);
  assert.equal(result.customers[0].debts, 0);
});

test("pedido pendente existente permite reconfirmar a dívida sem criar outra compra", async () => {
  await approveIdentity();
  const firstIntent = await checkout(15);
  const first = await issueBalanceCheckout(firstIntent.id, db);
  const secondIntent = await checkout(10);
  const second = await issueBalanceCheckout(secondIntent.id, db);
  await approve(second);
  await assert.rejects(() => approve(first), /409/);
  const latest = await getCustomerBalance(CUSTOMER_A, db);
  const renewed = await renewBalanceConsent(firstIntent.order_id, CUSTOMER_A, {
    account_revision: latest.account_revision,
    projected_balance_cents: latest.available_cents - 15000
  }, db);
  assert.equal(renewed.id, first.id);
  assert.equal(renewed.status, "PENDING");
  await approve(renewed);
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).balance_cents, -25000);
  assert.equal((await admin("/approvals?environment=PRODUCTION")).length, 2);
});

test("WhatsApp real de aplicação escolhe saldo, solicita aprovação e prepara a notificação sem enviar mensagens", async () => {
  await approveIdentity(); await fund();
  const contact = await db.from("whatsapp_contacts").insert({
    provider: "evolution", account: "test", wa_id: "5511999990000", customer_id: CUSTOMER_A
  }).select("id").single();
  assert.equal(contact.error, null);
  const conversation = await db.from("whatsapp_conversations").insert({ contact_id: contact.data!.id }).select("id").single();
  assert.equal(conversation.error, null);
  assert.equal((await db.rpc("commerce_mutate_cart", {
    p_customer_id: CUSTOMER_A, p_lines: [{ productId: PRODUCT_A, quantity: 15 }],
    p_mode: "increment", p_operation_id: randomUUID()
  })).error, null);
  let invoiceCalls = 0;
  const services = new SupabaseBotServices(db, {
    createInvoice: async () => { invoiceCalls++; throw new Error("UNEXPECTED_ORDER_INVOICE"); },
    getInvoice: async () => { throw new Error("UNEXPECTED_ORDER_INVOICE_QUERY"); }
  });
  let botState: BotState = {};
  async function message(text: string) {
    const response = await processConversation({
      eventId: randomUUID(), conversationId: conversation.data!.id, contactId: contact.data!.id,
      customerId: CUSTOMER_A, version: 0, text
    }, botState, services);
    botState = response.state;
    return response;
  }
  async function choose(action: string) {
    assert.ok(botState.choices?.some((choice) => choice.action === action), `Choice missing: ${action}`);
    return message(`v${botState.menuVersion}:${action}`);
  }
  await message("comprar");
  await choose("address:" + ADDRESS_A);
  assert.ok(botState.choices?.some((choice) => choice.label === "Saldo na conta"));
  const review = await choose("balance-review");
  const text = review.replies.filter((reply) => "text" in reply).map((reply) => "text" in reply ? reply.text : "").join("\n");
  assert.match(text, /aprova[çc][aã]o da Pontalti/i);
  assert.match(text, /50,00/);
  assert.ok(botState.choices?.some((choice) => choice.label === "Solicitar aprovação"));
  await choose("balance-confirm");
  assert.equal(invoiceCalls, 0);
  const purchases = await admin("/approvals?environment=PRODUCTION&status=PENDING");
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].amount_cents, 15000);
  assert.equal((await state()).orders.length, 0);
  const orderId = purchases[0].external_order_id;
  assert.equal((await db.from("orders").select("status").eq("id", orderId).single()).data?.status, "awaiting_balance_approval");
  await approve(purchases[0]);
  await syncBalanceCheckout(orderId, CUSTOMER_A, db);
  for (let i = 0; i < 3; i++) {
    const event = await db.rpc("commerce_claim_notification", { p_token: randomUUID(), p_account: "test" });
    assert.equal(event.error, null);
    if (!event.data) break;
  }
  const outbox = await db.from("whatsapp_outbox").select("content");
  assert.equal(outbox.error, null);
  assert.ok(outbox.data?.some((row) => /aprovou o uso de saldo/.test(row.content.text)));
  assert.equal((await getCustomerBalance(CUSTOMER_A, db)).debts_cents, 5000);
});
