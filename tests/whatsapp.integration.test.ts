import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import {
  localDatabase,
  seedTestDatabase,
  CUSTOMER_A,
  CUSTOMER_B,
  ADDRESS_A,
  ADDRESS_B,
  PRODUCT_A,
  PRODUCT_HIDDEN,
  TEST_API_URL,
  TEST_DATABASE_URL,
  localToken
} from "./support/database";
import { prepareCheckout, issueCheckoutPayment } from "@/lib/commerce/checkout";
import { syncInvoiceStatus } from "@/lib/cora/payment-sync";
import type { CoraInvoice, CreateInvoiceInput } from "@/lib/cora/client";
import { SupabaseBotServices } from "@/lib/whatsapp/repository";
import { processInbox, processOutbox, processNotification } from "@/lib/whatsapp/worker";
import { processConversation } from "@/lib/whatsapp/engine";
import { hashChallenge } from "@/lib/whatsapp/security";
import type { BotMessage } from "@/lib/whatsapp/types";
import { SupabaseTestCatalog } from "../scripts/support/supabase-test-catalog";

process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = localToken();
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3002";
process.env.WHATSAPP_LINK_SECRET = "pontalti-test-only-link-secret-1234567890";
const db = localDatabase();
beforeEach(async () => {
  await seedTestDatabase();
});

test("catálogo remoto é lido por GET e mantém IDs, preços e foto principal no espelho local", async () => {
  assert.equal((await db.from("product_images").insert([
    { marketplace_config_id: PRODUCT_A, storage_path: "products/secondary.jpg", is_primary: false, display_order: 0 },
    { marketplace_config_id: PRODUCT_A, storage_path: "products/primary.jpg", is_primary: true, display_order: 9 }
  ])).error, null);
  const reads: string[] = [];
  const source = createClient(TEST_API_URL, localToken("anon"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      assert.equal(options?.method, "GET");
      reads.push(String(url));
      return fetch(url, options);
    } }
  });
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    const catalog = new SupabaseTestCatalog(source, pool, "https://store.supabase.co");
    const page = await catalog.catalog("", 0);
    assert.equal(page.products.length, 1);
    assert.equal(page.products[0].id, PRODUCT_A);
    assert.equal(page.products[0].priceCents, 1000);
    assert.equal(page.products[0].imageUrl, "https://store.supabase.co/storage/v1/object/public/product-images/products/primary.jpg");
    assert.equal(page.hasMore, false);
    assert.deepEqual((await catalog.products([PRODUCT_A, PRODUCT_HIDDEN])).map((product) => product.id), [PRODUCT_A]);
    const cart = await mutate(1);
    const intent = await prepare(cart.version);
    assert.ok(intent.order_id);
    const paymentInput = (await db.from("checkout_intents").select("invoice_input").eq("id", intent.id).single()).data!.invoice_input;
    assert.equal(paymentInput.amountCents, 1000);
    assert.ok(reads.length >= 2);
    assert.ok(reads.every((url) => url.includes("/product_marketplace_config?")));
  } finally { await pool.end(); }
});
test("catálogo pagina três fotos individuais e reflete preço, foto removida e ocultação", async () => {
  assert.equal((await db.from("product_marketplace_config").insert(Array.from({ length: 6 }, (_, index) => ({
    id: randomUUID(), factory_product_id: 1200 + index, factory_sku: "REAL-" + index,
    display_title: "Produto publicado " + index, display_price: 15 + index, is_visible: true, display_order: index + 1
  })))).error, null);
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    const catalog = new SupabaseTestCatalog(localDatabase("anon"), pool, "https://store.supabase.co");
    const first = await catalog.catalog("", 0);
    const pages = await Promise.all([1, 2].map((page) => catalog.catalog("", page)));
    assert.equal(first.products.length, 3);
    assert.equal(first.hasMore, true);
    assert.deepEqual(pages.map((page) => page.products.length), [3, 1]);
    assert.deepEqual(pages.map((page) => page.hasMore), [true, false]);
    assert.equal(new Set([first, ...pages].flatMap((page) => page.products.map((product) => product.id))).size, 7);
    assert.equal((await catalog.catalog("", 3)).products.length, 0);
    const production = new SupabaseBotServices(db);
    for (let page = 0; page < 3; page++) {
      const result = await production.catalog("", page);
      assert.equal(result.products[0].id, [first, ...pages][page].products[0].id);
      assert.equal(result.products.length, page < 2 ? 3 : 1);
      assert.equal(result.hasMore, page < 2);
    }
    await db.from("product_marketplace_config").update({ display_price: 22 }).eq("id", PRODUCT_A);
    assert.equal((await catalog.products([PRODUCT_A]))[0].priceCents, 2200);
    assert.equal((await catalog.products([PRODUCT_A]))[0].imageUrl, null);
    await db.from("product_marketplace_config").update({ is_visible: false }).eq("id", PRODUCT_A);
    assert.deepEqual(await catalog.products([PRODUCT_A]), []);
    const denied = await db.rpc("commerce_mutate_cart", {
      p_customer_id: CUSTOMER_A, p_lines: [{ productId: PRODUCT_A, quantity: 1 }], p_mode: "increment", p_operation_id: "hidden-real-product"
    });
    assert.equal(denied.error?.message, "PRODUCT_UNAVAILABLE");
  } finally { await pool.end(); }
});
test("falha na leitura do catálogo não oculta produtos nem altera o carrinho existente", async () => {
  await mutate(1);
  const source = createClient("http://127.0.0.1:59999", localToken("anon"), {
    auth: { persistSession: false }, global: { fetch: async () => Response.json({ message: "unavailable" }, { status: 400 }) }
  });
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    const catalog = new SupabaseTestCatalog(source, pool, "https://store.supabase.co");
    await assert.rejects(() => catalog.products([PRODUCT_A]), /conferir os produtos/);
    assert.equal((await new SupabaseBotServices(db).cart(CUSTOMER_A)).items[0].quantity, 1);
    assert.equal((await db.from("product_marketplace_config").select("is_visible").eq("id", PRODUCT_A).single()).data?.is_visible, true);
  } finally { await pool.end(); }
});

function fixture() {
  const invoices = new Map<string, CoraInvoice>();
  const byKey = new Map<string, CoraInvoice>();
  const sent: BotMessage[] = [];
  const events: string[] = [];
  let creates = 0;
  const gateway = {
    createInvoice: async (input: CreateInvoiceInput, key: string) => {
      creates++;
      if (byKey.has(key)) return byKey.get(key)!;
      const invoice: CoraInvoice = {
        id: "inv_test_" + randomUUID(),
        status: "OPEN",
        total_amount: input.amountCents,
        total_paid: 0,
        code: input.code,
        pix: { emv: "PIX-DE-TESTE" },
        payment_options: { bank_slip: { url: "https://test.invalid/boleto.pdf", digitable: "TESTE" } }
      };
      invoices.set(invoice.id, invoice);
      byKey.set(key, invoice);
      return invoice;
    },
    getInvoice: async (id: string) => {
      const invoice = invoices.get(id);
      if (!invoice) throw new Error("NOT_FOUND");
      return structuredClone(invoice);
    }
  };
  const services = new SupabaseBotServices(db, gateway);
  const deps = {
    db,
    services,
    account: "test",
    invoiceCreate: gateway.createInvoice,
    invoiceGet: gateway.getInvoice,
    send: async (_account: string, _waId: string, message: BotMessage) => {
      sent.push(message);
      return { status: "accepted" as const, providerMessageId: randomUUID() };
    },
    notify: async (event: string) => {
      events.push(event);
    }
  };
  return { gateway, services, deps, invoices, sent, events, creates: () => creates };
}
async function mutate(
  quantity: number,
  operationId: string = randomUUID(),
  customerId = CUSTOMER_A,
  productId = PRODUCT_A
) {
  const result = await db.rpc("commerce_mutate_cart", {
    p_customer_id: customerId,
    p_lines: [{ productId, quantity }],
    p_mode: "increment",
    p_operation_id: operationId
  });
  assert.equal(result.error, null);
  return result.data as { version: number };
}
async function prepare(version: number, origin: "website" | "whatsapp" = "website", conversationId?: string) {
  return prepareCheckout(
    {
      customerId: CUSTOMER_A,
      addressId: ADDRESS_A,
      cartVersion: version,
      subtotalCents: 1000,
      origin,
      conversationId,
      ...(origin === "whatsapp" ? { feeCents: 0, delivery: "Retirada de teste" } : {})
    },
    db
  );
}
async function receive(text: string, externalId: string = randomUUID(), waId = "5511999990000") {
  const result = await db.rpc("whatsapp_receive", {
    p_account: "test",
    p_wa_id: waId,
    p_external_id: externalId,
    p_text: text
  });
  assert.equal(result.error, null);
  return result.data as string | null;
}
async function conversation() {
  const result = await db.from("whatsapp_conversations").select("id,state,contact_id").single();
  assert.equal(result.error, null);
  return result.data!;
}
async function drain(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 30 && (await processInbox(f.deps)); i++) {
    /* Executa até não haver entrada disponível. */
  }
  for (let i = 0; i < 80 && (await processOutbox(f.deps)); i++) {
    /* Envios são interceptados. */
  }
}
async function choose(f: ReturnType<typeof fixture>, action: string) {
  const cv = await conversation();
  const state = cv.state;
  assert.equal(
    state.choices.some((choice: { action: string }) => choice.action === action),
    true,
    "Opção não encontrada: " + action
  );
  await receive("v" + state.menuVersion + ":" + action);
  await drain(f);
}
async function linkedFixture() {
  const f = fixture();
  await receive("menu");
  const cv = await conversation();
  assert.equal((await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER_A }).eq("id", cv.contact_id)).error, null);
  await drain(f);
  return { ...f, contactId: cv.contact_id as string };
}
async function pastOrder(f: ReturnType<typeof fixture>, quantity = 1) {
  const cart = await mutate(quantity);
  const intent = await prepareCheckout({ customerId: CUSTOMER_A, addressId: ADDRESS_A,
    cartVersion: cart.version, subtotalCents: quantity * 1000, origin: "website" }, db);
  assert.equal(await issueCheckoutPayment(intent.id, db, f.gateway.createInvoice), "ready");
  const invoice = [...f.invoices.values()][0];
  invoice.status = "PAID";
  invoice.total_paid = invoice.total_amount;
  await syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice);
  return intent.order_id;
}

test("cadastro pela conversa salva somente o campo confirmado e protege CPF e outras contas", async () => {
  const f = await linkedFixture();
  await receive("meus dados");
  await drain(f);
  await choose(f, "account:name");
  await receive("Nome alterado pelo WhatsApp");
  await drain(f);
  assert.equal((await db.from("customers").select("full_name").eq("id", CUSTOMER_A).single()).data?.full_name, "Cliente de teste A");
  await choose(f, "account:save");
  const profile = (await db.from("customers").select("full_name,cpf").eq("id", CUSTOMER_A).single()).data!;
  assert.equal(profile.full_name, "Nome alterado pelo WhatsApp");
  assert.equal(profile.cpf, "52998224725");
  assert.equal((await db.from("customers").select("full_name").eq("id", CUSTOMER_B).single()).data?.full_name, "Cliente de teste B");
  await f.services.updateProfile(CUSTOMER_A, f.contactId, { phone: "(11) 98888-7777" }, "phone");
  await f.services.updateProfile(CUSTOMER_A, f.contactId, { phone: null }, "remove-phone");
  assert.equal((await f.services.profile(CUSTOMER_A)).phone, null);
  const unauthorized = await localDatabase("authenticated", CUSTOMER_B).rpc("whatsapp_update_customer", {
    p_customer_id: CUSTOMER_A, p_contact_id: f.contactId, p_operation_id: "attack", p_kind: "profile", p_data: { fullName: "Intruso" }
  });
  assert.ok(unauthorized.error);
  await assert.rejects(() => f.services.updateProfile(CUSTOMER_B, f.contactId, { fullName: "Intruso" }, "wrong-buyer"), /vínculo/);
});
test("salvar endereço é idempotente, mantém um padrão e recusa endereço de outra conta", async () => {
  const f = await linkedFixture();
  const input = { zipCode: "01001000", street: "Rua nova", number: "20", complement: "Sala 2",
    neighborhood: "Centro", city: "São Paulo", state: "SP", isDefault: true };
  await Promise.all(Array.from({ length: 4 }, () => f.services.saveAddress(CUSTOMER_A, f.contactId, input, undefined, "new-address")));
  const addresses = (await db.from("customer_addresses").select("id,is_default").eq("customer_id", CUSTOMER_A)).data!;
  assert.equal(addresses.length, 2);
  const added = addresses.find((address) => address.id !== ADDRESS_A)!;
  assert.equal(added.is_default, true);
  await f.services.saveAddress(CUSTOMER_A, f.contactId, { ...input, street: "Rua corrigida" }, added.id, "edit-address");
  assert.match((await f.services.addresses(CUSTOMER_A)).find((address) => address.id === added.id)!.label, /Rua corrigida/);
  await assert.rejects(() => f.services.saveAddress(CUSTOMER_A, f.contactId, input, ADDRESS_B, "wrong-address"), /sua conta/);
  await Promise.all([
    f.services.saveAddress(CUSTOMER_A, f.contactId, input, ADDRESS_A, "default-a"),
    f.services.saveAddress(CUSTOMER_A, f.contactId, input, added.id, "default-b")
  ]);
  assert.equal((await db.from("customer_addresses").select("id").eq("customer_id", CUSTOMER_A).eq("is_default", true)).data?.length, 1);
  await f.services.unlink(f.contactId);
  await assert.rejects(() => f.services.saveAddress(CUSTOMER_A, f.contactId, input, undefined, "unlinked"), /vínculo/);
});
test("repetir pedido soma ao carrinho aos preços atuais uma única vez, sem criar pedido ou cobrança", async () => {
  const f = await linkedFixture();
  const id = await pastOrder(f, 2);
  await mutate(1);
  await db.from("product_marketplace_config").update({ display_price: 12 }).eq("id", PRODUCT_A);
  const lines = (await f.services.repeatPreview(CUSTOMER_A, id))!;
  assert.equal(lines[0].priceCents, 1200);
  await Promise.all(Array.from({ length: 6 }, () => f.services.repeatOrder(CUSTOMER_A, f.contactId, id, lines, "repeat-once")));
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 3);
  assert.equal((await db.from("orders").select("id")).data?.length, 1);
  assert.equal((await db.from("order_payments").select("id")).data?.length, 1);
  assert.equal((await db.from("order_items").select("quantity,unit_price").eq("order_id", id).single()).data?.unit_price, 10);
  assert.equal(f.creates(), 1);
  assert.equal(await f.services.repeatPreview(CUSTOMER_B, id), null);
  const denied = await localDatabase("authenticated", CUSTOMER_B).rpc("whatsapp_repeat_order", {
    p_customer_id: CUSTOMER_A, p_contact_id: f.contactId, p_order_id: id, p_lines: lines, p_operation_id: "attack"
  });
  assert.ok(denied.error);
});
test("editar endereço usado preserva o pedido anterior e disponibiliza a correção para a próxima compra", async () => {
  const f = await linkedFixture();
  const id = await pastOrder(f);
  const address = (await f.services.addresses(CUSTOMER_A)).find((item) => item.id === ADDRESS_A)!;
  await f.services.saveAddress(CUSTOMER_A, f.contactId, { ...address.details!, number: "99" }, ADDRESS_A, "correct-used-address");
  await f.services.saveAddress(CUSTOMER_A, f.contactId, { ...address.details!, number: "99" }, ADDRESS_A, "correct-used-address");
  const active = await f.services.addresses(CUSTOMER_A);
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, ADDRESS_A);
  assert.equal(active[0].details?.number, "99");
  const old = (await db.from("orders").select("address_id,customer_addresses(number)").eq("id", id).single()).data!;
  assert.equal(old.address_id, ADDRESS_A);
  assert.equal((old.customer_addresses as unknown as { number: string }).number, "1");
  const cart = await mutate(1);
  await assert.rejects(() => prepare(cart.version), /endereço da sua conta/);
  const next = await prepareCheckout({ customerId: CUSTOMER_A, addressId: active[0].id,
    cartVersion: cart.version, subtotalCents: 1000, origin: "website" }, db);
  assert.notEqual(next.order_id, id);
});
test("repetição recusa mudança de preço, produto oculto e limite de quantidade sem alterar carrinho", async () => {
  const f = await linkedFixture();
  const id = await pastOrder(f);
  const lines = (await f.services.repeatPreview(CUSTOMER_A, id))!;
  await db.from("product_marketplace_config").update({ display_price: 13 }).eq("id", PRODUCT_A);
  await assert.rejects(() => f.services.repeatOrder(CUSTOMER_A, f.contactId, id, lines, "price"), /preço mudou/);
  assert.equal((await f.services.cart(CUSTOMER_A)).items.length, 0);
  const changed = (await f.services.repeatPreview(CUSTOMER_A, id))!;
  await db.from("product_marketplace_config").update({ is_visible: false }).eq("id", PRODUCT_A);
  await assert.rejects(() => f.services.repeatOrder(CUSTOMER_A, f.contactId, id, changed, "hidden"), /disponível/);
  assert.equal((await f.services.cart(CUSTOMER_A)).items.length, 0);
  await db.from("product_marketplace_config").update({ is_visible: true }).eq("id", PRODUCT_A);
  await mutate(999);
  await assert.rejects(() => f.services.repeatOrder(CUSTOMER_A, f.contactId, id, changed, "overflow"), /999/);
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 999);
});
test("menu repete último pedido e Pix recupera a mesma cobrança antes e depois do pagamento", async () => {
  const f = await linkedFixture();
  const id = await pastOrder(f);
  await receive("repetir ultimo pedido");
  await drain(f);
  await choose(f, "repeat-confirm");
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 1);
  const cart = await f.services.cart(CUSTOMER_A);
  const intent = await prepareCheckout({ customerId: CUSTOMER_A, addressId: ADDRESS_A,
    cartVersion: cart.version, subtotalCents: 1000, origin: "website" }, db);
  await issueCheckoutPayment(intent.id, db, f.gateway.createInvoice);
  await receive("pix");
  await drain(f);
  await choose(f, "pix:" + intent.order_id);
  assert.ok(f.sent.some((message) => message.type === "text" && message.text === "PIX-DE-TESTE"));
  assert.equal(f.creates(), 2);
  const invoice = [...f.invoices.values()].find((invoice) => invoice.code === intent.order_id)!;
  invoice.status = "PAID";
  invoice.total_paid = invoice.total_amount;
  f.sent.length = 0;
  await choose(f, "pix:" + intent.order_id);
  assert.equal(f.sent.some((message) => message.type === "text" && message.text === "PIX-DE-TESTE"), false);
  assert.match(JSON.stringify(f.sent), /Pagamento confirmado/);
  assert.equal((await db.from("orders").select("id")).data?.length, 2);
  assert.notEqual(intent.order_id, id);
});
test("histórico pagina pedidos e Pix encontra pendência antiga sem expor outra conta", async () => {
  const f = await linkedFixture();
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: randomUUID(), customer_id: CUSTOMER_A,
    address_id: ADDRESS_A, status: index === 0 ? "awaiting_payment" : "delivered", subtotal: 10, total: 10,
    created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }));
  assert.equal((await db.from("orders").insert([...rows, { ...rows[0], id: randomUUID(),
    customer_id: CUSTOMER_B, address_id: ADDRESS_B, total: 999 }])).error, null);
  await receive("pedidos");
  await drain(f);
  let cv = await conversation();
  assert.equal(cv.state.choices.filter((choice: { action: string }) => choice.action.startsWith("order:")).length, 8);
  await choose(f, "orders:1");
  cv = await conversation();
  assert.ok(cv.state.choices.some((choice: { action: string }) => choice.action === "order:" + rows[0].id));
  assert.ok(f.sent.every((message) => !JSON.stringify(message).includes("999,00")));
  await receive("pix");
  await drain(f);
  cv = await conversation();
  assert.ok(cv.state.choices.some((choice: { action: string }) => choice.action === "pix:" + rows[0].id));
});

test("incrementos concorrentes são atômicos e repetir uma operação não duplica quantidade", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => mutate(1)));
  assert.equal(results.length, 20);
  await mutate(2, "repeat");
  await mutate(2, "repeat");
  const cart = await new SupabaseBotServices(db).cart(CUSTOMER_A);
  assert.equal(cart.items[0].quantity, 22);
});
test("checkout simultâneo entre site e WhatsApp recupera o mesmo pedido e cobrança", async () => {
  await receive("menu");
  const cv = await conversation();
  await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER_A }).eq("id", cv.contact_id);
  const f = fixture();
  const cart = await mutate(1);
  const intents = await Promise.all([prepare(cart.version), prepare(cart.version, "whatsapp", cv.id)]);
  assert.equal(intents[0].order_id, intents[1].order_id);
  await Promise.all(intents.map((intent) => issueCheckoutPayment(intent.id, db, f.gateway.createInvoice)));
  assert.equal(f.creates(), 1);
  assert.equal((await db.from("orders").select("id")).data?.length, 1);
  assert.equal((await db.from("order_payments").select("id")).data?.length, 1);
});
test("alteração de preço, versão ou endereço de outra conta impede a cobrança", async () => {
  const cart = await mutate(1);
  await assert.rejects(
    () =>
      prepareCheckout(
        {
          customerId: CUSTOMER_A,
          addressId: ADDRESS_B,
          cartVersion: cart.version,
          subtotalCents: 1000,
          origin: "website"
        },
        db
      ),
    /sua conta/
  );
  await db.from("product_marketplace_config").update({ display_price: 11 }).eq("id", PRODUCT_A);
  await assert.rejects(() => prepare(cart.version), /preço mudou/);
  await mutate(1);
  await assert.rejects(() => prepare(cart.version), /carrinho mudou/);
  assert.equal((await db.from("orders").select("id")).data?.length, 0);
});
test("timeout preserva intenção e reutiliza chave e cobrança; adições posteriores ficam no carrinho", async () => {
  const f = fixture();
  const cart = await mutate(1);
  const intent = await prepare(cart.version);
  let first = true;
  const keys: string[] = [];
  const timeout = async (input: CreateInvoiceInput, key: string) => {
    keys.push(key);
    const invoice = await f.gateway.createInvoice(input, key);
    if (first) {
      first = false;
      throw new Error("TIMEOUT");
    }
    return invoice;
  };
  assert.equal(await issueCheckoutPayment(intent.id, db, timeout), "pending");
  await mutate(2);
  await db
    .from("checkout_intents")
    .update({ next_attempt_at: new Date(0).toISOString() })
    .eq("id", intent.id);
  assert.equal(await issueCheckoutPayment(intent.id, db, timeout), "ready");
  assert.equal(keys[0], keys[1]);
  assert.equal(f.invoices.size, 1);
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 2);
  assert.equal((await db.from("order_payments").select("id")).data?.length, 1);
});
test("pagamento repetido gera um aviso e uma consulta atrasada não regride pago", async () => {
  const f = fixture();
  const cart = await mutate(1);
  const intent = await prepare(cart.version);
  await issueCheckoutPayment(intent.id, db, f.gateway.createInvoice);
  const invoice = Array.from(f.invoices.values())[0];
  invoice.status = "PAID";
  invoice.total_paid = invoice.total_amount;
  await Promise.all([
    syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice),
    syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice)
  ]);
  invoice.status = "OPEN";
  const sync = await syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice);
  assert.equal(sync?.paymentStatus, "paid");
  const events = await db.from("commerce_notification_events").select("id").eq("event", "payment_confirmed");
  assert.equal(events.data?.length, 1);
});
test("RLS bloqueia dados do canal, checkout privilegiado e leitura de outro comprador", async () => {
  const anonymous = localDatabase("anon");
  const buyer = localDatabase("authenticated", CUSTOMER_A);
  assert.ok((await anonymous.from("whatsapp_contacts").select("id")).error);
  assert.ok(
    (
      await buyer.rpc("commerce_mutate_cart", {
        p_customer_id: CUSTOMER_B,
        p_lines: [],
        p_mode: "clear",
        p_operation_id: "bad"
      })
    ).error
  );
  assert.ok(
    (
      await buyer
        .from("cart_items")
        .insert({ cart_id: randomUUID(), product_config_id: PRODUCT_A, quantity: 1, unit_price_snapshot: 1 })
    ).error
  );
  const own = await buyer.rpc("commerce_my_cart", {
    p_lines: [{ productId: PRODUCT_A, quantity: 1 }],
    p_mode: "increment",
    p_operation_id: "mine"
  });
  assert.equal(own.error, null);
  const hidden = await buyer.rpc("commerce_my_cart", {
    p_lines: [{ productId: PRODUCT_HIDDEN, quantity: 1 }],
    p_mode: "increment",
    p_operation_id: "hidden"
  });
  assert.ok(hidden.error);
  const cv = own.data.version;
  const intent = await prepare(cv);
  assert.deepEqual((await localDatabase("authenticated", CUSTOMER_B).from("orders").select("id")).data, []);
  assert.equal(await new SupabaseBotServices(db).order(CUSTOMER_B, intent.order_id), null);
});
test("vínculo exige confirmação no chat, é de uso único e não pode ser apropriado por outra conta", async () => {
  const f = fixture();
  await receive("conta");
  await drain(f);
  const cv = await conversation();
  const link = await db.from("whatsapp_account_links").select("token_hash").single();
  const tokenHash = link.data!.token_hash;
  const claimed = await db.rpc("whatsapp_claim_link", {
    p_token_hash: tokenHash,
    p_customer_id: CUSTOMER_A,
    p_challenge_hash: hashChallenge(tokenHash, "123456")
  });
  assert.equal(claimed.error, null);
  const conflict = await db.rpc("whatsapp_claim_link", {
    p_token_hash: tokenHash,
    p_customer_id: CUSTOMER_B,
    p_challenge_hash: "wrong"
  });
  assert.ok(conflict.error);
  assert.equal(
    (await db.from("whatsapp_contacts").select("customer_id").eq("id", cv.contact_id).single()).data?.customer_id,
    null
  );
  await receive("vincular 123456");
  await drain(f);
  assert.equal(
    (await db.from("whatsapp_contacts").select("customer_id").eq("id", cv.contact_id).single()).data?.customer_id,
    CUSTOMER_A
  );
  assert.ok(
    (
      await db.rpc("whatsapp_claim_link", {
        p_token_hash: tokenHash,
        p_customer_id: CUSTOMER_A,
        p_challenge_hash: "again"
      })
    ).error
  );
  assert.ok((await db.rpc("whatsapp_unlink", { p_contact_id: cv.contact_id, p_customer_id: CUSTOMER_B })).error);
});
test("CPF inválido bloqueia emissão e a correção no cadastro permite retomar o carrinho", async () => {
  const f = fixture();
  await mutate(1);
  await receive("menu");
  await drain(f);
  const cv = await conversation();
  assert.equal((await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER_A }).eq("id", cv.contact_id)).error, null);
  assert.equal((await db.from("customers").update({ cpf: "12345678909" }).eq("id", CUSTOMER_A)).error, null);
  await receive("comprar");
  await drain(f);
  assert.equal((await conversation()).state.phase, "cart");
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 1);
  assert.equal((await db.from("orders").select("id")).data?.length, 0);
  assert.equal(f.creates(), 0);
  assert.ok(f.sent.some(message => message.type === "choices" && message.options.some(option => option.label === "Retomar compra")));
  assert.equal((await db.from("customers").update({ cpf: "52998224725" }).eq("id", CUSTOMER_A)).error, null);
  await choose(f, "checkout");
  await choose(f, "address:" + ADDRESS_A);
  await choose(f, "confirm");
  assert.equal(f.creates(), 1);
  assert.equal((await db.from("orders").select("status").single()).data?.status, "awaiting_payment");
  assert.equal((await f.services.cart(CUSTOMER_A)).items.length, 0);
});
test("entrada repetida e dois workers processam uma só ação; saída incerta não é reenviada", async () => {
  const f = fixture();
  const id = await receive("produtos", "same");
  assert.ok(id);
  assert.equal(await receive("produtos", "same"), null);
  await Promise.all([processInbox(f.deps), processInbox(f.deps)]);
  assert.equal(
    (await db.from("whatsapp_inbox_events").select("status")).data?.filter((row) => row.status === "done").length,
    1
  );
  const unknown = { ...f.deps, send: async () => ({ status: "unknown" as const, error: "TIMEOUT" }) };
  await processOutbox(unknown);
  const original = (await db.from("whatsapp_outbox").select("id,status,attempts").eq("status", "unknown").single())
    .data!;
  await drain(f);
  const row = (await db.from("whatsapp_outbox").select("status,attempts").eq("id", original.id).single()).data!;
  assert.equal(row.status, "unknown");
  assert.equal(row.attempts, 1);
});
test("desvincular cancela mensagens privadas que ainda estavam na saída", async () => {
  const f = fixture();
  await receive("menu");
  await drain(f);
  const cv = await conversation();
  await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER_A }).eq("id", cv.contact_id);
  await db.from("whatsapp_outbox").insert({
    conversation_id: cv.id,
    dedupe_key: "private",
    content: { type: "text", text: "Dado privado", customerId: CUSTOMER_A }
  });
  await db.rpc("whatsapp_unlink", { p_contact_id: cv.contact_id, p_customer_id: CUSTOMER_A });
  const before = f.sent.length;
  await processOutbox(f.deps);
  assert.equal(f.sent.length, before);
  assert.equal(
    (await db.from("whatsapp_outbox").select("status").eq("dedupe_key", "private").single()).data?.status,
    "cancelled"
  );
});
test("jornada completa usa catálogo, carrinho e cobrança no mesmo banco e confirma Cora", async () => {
  const f = fixture();
  await receive("produtos");
  await drain(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "product");
  await choose(f, "select:" + PRODUCT_A);
  await choose(f, "quantity:2");
  let cv = await conversation();
  assert.equal(cv.state.pending[0].quantity, 2);
  await choose(f, "checkout");
  const link = (await db.from("whatsapp_account_links").select("token_hash").single()).data!;
  await db.rpc("whatsapp_claim_link", {
    p_token_hash: link.token_hash,
    p_customer_id: CUSTOMER_A,
    p_challenge_hash: hashChallenge(link.token_hash, "654321")
  });
  await receive("vincular 654321");
  await drain(f);
  await choose(f, "merge:yes");
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 2);
  await choose(f, "checkout");
  await choose(f, "address:" + ADDRESS_A);
  await choose(f, "confirm");
  cv = await conversation();
  const orderId = cv.state.orderId;
  assert.ok(orderId);
  await choose(f, "boleto:" + orderId);
  assert.ok(f.sent.some(message => message.type === "document" && message.url === "https://test.invalid/boleto.pdf"));
  await choose(f, "pix:" + orderId);
  assert.ok(f.sent.some((message) => message.type === "text" && message.text === "PIX-DE-TESTE"));
  const invoice = Array.from(f.invoices.values())[0];
  invoice.status = "PAID";
  invoice.total_paid = invoice.total_amount;
  await syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice);
  for (let i = 0; i < 5 && (await processNotification(f.deps)); i++) {
    /* Avisos de compra e pagamento. */
  }
  await drain(f);
  assert.equal((await db.from("orders").select("status,origin").eq("id", orderId).single()).data?.status, "paid");
  assert.equal((await db.from("orders").select("origin").eq("id", orderId).single()).data?.origin, "whatsapp");
  assert.ok(
    f.sent.some((message) => message.type === "text" && message.text.includes("Pagamento confirmado pela Cora"))
  );
  assert.equal((await f.services.cart(CUSTOMER_A)).items.length, 0);
});

test("webhook autentica, valida instância e confirma recebimento só depois de persistir", async () => {
  process.env.WHATSAPP_BOT_ENABLED = "true";
  process.env.WHATSAPP_WEBHOOK_SECRET = "s".repeat(40);
  process.env.EVOLUTION_INSTANCE = "test";
  const { POST } = await import("@/app/api/webhooks/whatsapp/evolution/route");
  const body = {
    event: "messages.upsert",
    instance: "test",
    apikey: "nao-persistir",
    data: {
      key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "webhook" },
      message: { conversation: "produtos" }
    }
  };
  const request = (secret: string, payload: unknown = body) =>
    new Request("http://localhost/api/webhooks/whatsapp/evolution", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-whatsapp-webhook-secret": secret },
      body: JSON.stringify(payload)
    });
  assert.equal((await POST(request("wrong"))).status, 401);
  assert.equal((await POST(request("s".repeat(40), { ...body, instance: "other" }))).status, 400);
  assert.deepEqual(await (await POST(request("s".repeat(40)))).json(), { accepted: 1 });
  assert.deepEqual(await (await POST(request("s".repeat(40)))).json(), { accepted: 0 });
  const saved = (await db.from("whatsapp_inbox_events").select("text").single()).data!;
  assert.deepEqual(saved, { text: "produtos" });
});
test("queda após alterar carrinho recupera evento sem aplicar a quantidade novamente", async () => {
  const f = fixture();
  await receive("menu");
  await drain(f);
  const cv = await conversation();
  await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER_A }).eq("id", cv.contact_id);
  await db
    .from("whatsapp_conversations")
    .update({ state: { customerId: CUSTOMER_A, phase: "quantity", productId: PRODUCT_A, quantityMode: "increment" } })
    .eq("id", cv.id);
  await receive("2");
  const token = randomUUID();
  const claimed = (await db.rpc("whatsapp_claim_event", { p_token: token })).data!;
  await processConversation(
    {
      eventId: claimed.event.id,
      conversationId: cv.id,
      contactId: cv.contact_id,
      customerId: CUSTOMER_A,
      version: claimed.conversation.version,
      text: "2"
    },
    claimed.conversation.state,
    f.services
  );
  // Simula interrupção antes de gravar sessão/saída e expiração das duas leases.
  await db
    .from("whatsapp_inbox_events")
    .update({ lease_until: new Date(0).toISOString() })
    .eq("id", claimed.event.id);
  await db
    .from("whatsapp_conversations")
    .update({ lease_until: new Date(0).toISOString() })
    .eq("id", cv.id);
  await drain(f);
  assert.equal((await f.services.cart(CUSTOMER_A)).items[0].quantity, 2);
});
test("respostas incompletas do banco não marcam pago nem gravam cobrança inválida", async () => {
  const f = fixture();
  const cart = await mutate(1);
  const intent = await prepare(cart.version);
  assert.equal(
    await issueCheckoutPayment(intent.id, db, async (input, key) => ({
      ...(await f.gateway.createInvoice(input, key)),
      total_amount: undefined as unknown as number
    })),
    "pending"
  );
  assert.equal((await db.from("order_payments").select("id")).data?.length, 0);
  await db
    .from("checkout_intents")
    .update({ next_attempt_at: new Date(0).toISOString() })
    .eq("id", intent.id);
  await issueCheckoutPayment(intent.id, db, f.gateway.createInvoice);
  const invoice = Array.from(f.invoices.values())[0];
  invoice.status = "PAID";
  invoice.total_paid = 0;
  await assert.rejects(() => syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice));
  assert.equal(
    (await db.from("orders").select("status").eq("id", intent.order_id).single()).data?.status,
    "awaiting_payment"
  );
});
test("dados Pix/boleto que chegam depois da emissão são recuperados na consulta", async () => {
  const f = fixture();
  const cart = await mutate(1);
  const intent = await prepare(cart.version);
  await issueCheckoutPayment(intent.id, db, async (input, key) => ({
    ...(await f.gateway.createInvoice(input, key)),
    pix: null,
    payment_options: null
  }));
  assert.equal((await db.from("order_payments").select("pix_qr_code").single()).data?.pix_qr_code, null);
  const invoice = Array.from(f.invoices.values())[0];
  await syncInvoiceStatus(invoice.id, db, f.gateway.getInvoice);
  assert.equal((await db.from("order_payments").select("pix_qr_code").single()).data?.pix_qr_code, "PIX-DE-TESTE");
});
test("tentativa antiga exige conciliação e não dispara nova emissão", async () => {
  const f = fixture();
  const cart = await mutate(1);
  const intent = await prepare(cart.version);
  await db
    .from("checkout_intents")
    .update({ first_attempt_at: new Date(Date.now() - 20 * 60_000).toISOString() })
    .eq("id", intent.id);
  assert.equal(await issueCheckoutPayment(intent.id, db, f.gateway.createInvoice), "review");
  assert.equal(f.creates(), 0);
});
