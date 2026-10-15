import { test } from "node:test";
import assert from "node:assert/strict";
import { processConversation } from "./engine";
import type { BotServices, BotState } from "./types";

function fixture(balanceCents = 1000) {
  const calls: unknown[][] = [];
  let version = 0;
  let state: BotState = { customerId: "buyer" };
  const api: BotServices = {
    settings: async () => ({ unitLabel: "unidade", delivery: { enabled: true, description: "Retirada", feeCents: 0, states: ["SP"] } }),
    catalog: async () => ({ products: [], hasMore: false }), products: async () => [],
    cart: async () => ({ version: 3, subtotalCents: 2000, items: [{ productId: "product", quantity: 2, title: "Bojo", priceCents: 1000, available: true }] }),
    mutateCart: async () => {}, profileComplete: async () => true,
    profile: async () => ({ fullName: "Cliente", phone: null }), updateProfile: async () => {}, saveAddress: async () => {},
    addresses: async () => [{ id: "address", label: "Endereço", state: "SP" }], repeatPreview: async () => null, repeatOrder: async () => {},
    orders: async () => [], order: async (_customer, id) => ({ id, totalCents: 2000, status: "awaiting_balance_approval", delivery: "Retirada", payment: null }),
    checkout: async () => { throw new Error("Cora invoice must not be created for balance"); },
    createLink: async () => "https://test/link", confirmLink: async () => null, unlink: async () => {}, articles: async () => [], accountUrl: (path) => "https://test" + path,
    finance: {
      summary: async () => ({ customer_id: 1, balance_cents: balanceCents, available_cents: balanceCents, reserved_cents: 0,
        debts_cents: Math.max(0, -balanceCents), credit_limit_cents: 0, account_revision: 7, environment: "PRODUCTION" }),
      deposits: async () => [],
      deposit: async (...args) => { calls.push(args); return { id: "deposit", external_customer_id: "buyer", amount_cents: 30000, status: "OPEN", kind: "BOLETO", boleto_url: "https://bank.test/boleto", digitable: "123", environment: "PRODUCTION" }; },
      claim: async (...args) => { calls.push(args); return { id: "claim", external_customer_id: "buyer", amount_cents: 30000, status: "PENDING", kind: "BANK_CLAIM", boleto_url: null, digitable: null, environment: "PRODUCTION" }; },
      checkout: async (...args) => { calls.push(args); return { orderId: "order", status: balanceCents >= 2000 ? "APPROVED" : "PENDING" }; }
    }
  };
  const send = async (text: string, customerId: string | null = "buyer") => {
    const result = await processConversation({ eventId: "event-" + version, conversationId: "conversation", contactId: "contact", customerId, version: version++, text }, state, api);
    state = result.state; return result;
  };
  const choose = (action: string) => send("v" + state.menuVersion + ":" + action);
  return { api, calls, send, choose, state: () => state };
}
test("WhatsApp offers account balance and explains negative balance before requesting approval", async () => {
  const f = fixture(1000);
  await f.send("comprar");
  const address = await f.choose("address:address");
  assert.match(JSON.stringify(address.replies), /Saldo na conta/);
  const review = await f.choose("balance-review");
  assert.match(JSON.stringify(review.replies), /saldo devedor.*R\$.*10,00/);
  assert.match(JSON.stringify(review.replies), /depende da aprovação da Pontalti/);
  assert.match(JSON.stringify(review.replies), /não seguirá para produção ou envio/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.state().preview?.balanceConsent, { account_revision: 7, projected_balance_cents: -1000 });
  const oldMenu = f.state().menuVersion;
  const requested = await f.choose("balance-confirm");
  assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(requested.replies), /aguarda a aprovação da Pontalti/);
  await f.send("v" + oldMenu + ":balance-confirm");
  assert.equal(f.calls.length, 1);
});
test("positive account balance confirms without a Cora invoice; already negative requires approval", async () => {
  const positive = fixture(3000);
  await positive.send("comprar"); await positive.choose("address:address");
  const review = await positive.choose("balance-review");
  assert.match(JSON.stringify(review.replies), /Confirmar com saldo/);
  assert.doesNotMatch(JSON.stringify(review.replies), /Solicitar aprovação/);
  await positive.choose("balance-confirm");
  assert.equal(positive.calls.length, 1);
  const negative = fixture(-5000);
  await negative.send("comprar"); await negative.choose("address:address");
  const debt = await negative.choose("balance-review");
  assert.match(JSON.stringify(debt.replies), /70,00/);
  assert.match(JSON.stringify(debt.replies), /Solicitar aprovação/);
});
test("unlinked number cannot query a customer's account and stale account state is cleared", async () => {
  const f = fixture();
  f.api.finance!.summary = async () => { throw new Error("private account must not be queried"); };
  const result = await f.send("saldo", null);
  assert.match(JSON.stringify(result.replies), /link seguro/);
  assert.equal(result.state.balanceQuote, undefined);
});
test("deposit claim only records a request after explicit value, valid date, reference and confirmation", async () => {
  const f = fixture();
  await f.send("já depositei");
  await f.send("300,00");
  const invalid = await f.send("31/02/2026");
  assert.match(JSON.stringify(invalid.replies), /data válida/);
  await f.send("15/10/2025");
  const review = await f.send("Depósito identificado no comprovante de teste");
  assert.match(JSON.stringify(review.replies), /não confirma pagamento ou libera saldo/);
  assert.equal(f.calls.length, 0);
  const result = await f.choose("deposit-confirm");
  assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0][1] as { amountCents: number }).amountCents, 30000);
  assert.match(JSON.stringify(result.replies), /Nenhum crédito foi liberado/);
  await f.send("1");
  assert.equal(f.calls.length, 1);
});
test("adding balance creates an individual boleto only after confirmation and never creates a product order", async () => {
  const f = fixture();
  await f.send("adicionar saldo");
  await f.send("300,00");
  assert.equal(f.calls.length, 0);
  const result = await f.choose("deposit-confirm");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], 30000);
  assert.match(JSON.stringify(result.replies), /https:\/\/bank.test\/boleto/);
  assert.match(JSON.stringify(result.replies), /depende da confirmação bancária/);
});
test("renewing a pending order includes its own reservation in the projection and never creates a second order", async () => {
  const f = fixture(0);
  f.api.order = async (_customer, id) => ({ id, totalCents: 2000, status: "awaiting_balance_approval", delivery: "Retirada",
    payment: null, balanceNeedsReview: true, balanceReservedCents: 1000 });
  f.api.finance!.renewConsent = async (...args) => { f.calls.push(args); };
  Object.assign(f.state(), { phase: "payment", menuVersion: 1, choices: [{ action: "balance-order-review:order", label: "Revisar novo saldo" }] });
  const review = await f.choose("balance-order-review:order");
  assert.match(JSON.stringify(review.replies), /Já reservado neste pedido/);
  assert.equal(f.state().preview?.balanceConsent?.projected_balance_cents, -1000);
  await f.choose("balance-confirm");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], "order");
  assert.deepEqual(f.calls[0][2], { account_revision: 7, projected_balance_cents: -1000 });
});
