import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { disableCoreFinanceForLocalFixtures } from "./support/local-finance-isolation";
import { localDatabase, seedTestDatabase, CUSTOMER_A, ADDRESS_A, PRODUCT_A } from "../tests/support/database";

async function main() {
  loadEnvConfig(process.cwd());
  disableCoreFinanceForLocalFixtures();
  if (process.env.CORA_ENV !== "stage") throw new Error("STAGE_REQUIRED");
  // O teste usa as credenciais Cora existentes, mas SOMENTE o banco local fixo.
  const db = localDatabase();
  await seedTestDatabase();
  const { createInvoice, simulatePaymentInStage } = await import("../src/lib/cora/client");
  const { prepareCheckout, issueCheckoutPayment } = await import("../src/lib/commerce/checkout");
  const { syncInvoiceStatus } = await import("../src/lib/cora/payment-sync");
  await db.from("product_marketplace_config").update({ display_price: 5 }).eq("id", PRODUCT_A);
  const received = await db.rpc("whatsapp_receive", {
    p_account: "cora-stage-test",
    p_wa_id: "5511999990000",
    p_external_id: "stage-smoke",
    p_text: "teste local"
  });
  assert.equal(received.error, null);
  const cv = (await db.from("whatsapp_conversations").select("id,contact_id").single()).data!;
  const bound = await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER_A }).eq("id", cv.contact_id);
  assert.equal(bound.error, null);
  const cart = await db.rpc("commerce_mutate_cart", {
    p_customer_id: CUSTOMER_A,
    p_lines: [{ productId: PRODUCT_A, quantity: 1 }],
    p_mode: "increment",
    p_operation_id: "stage-cart"
  });
  assert.equal(cart.error, null);
  const intent = await prepareCheckout(
    {
      customerId: CUSTOMER_A,
      addressId: ADDRESS_A,
      cartVersion: cart.data.version,
      subtotalCents: 500,
      origin: "whatsapp",
      conversationId: cv.id,
      feeCents: 0,
      delivery: "Retirada de teste"
    },
    db
  );
  console.log("Pedido de teste reservado no banco local. Emitindo R$ 5,00 em Cora stage.");
  const status = await issueCheckoutPayment(intent.id, db, createInvoice);
  assert.equal(status, "ready", "EMISSION_NOT_READY");
  const payment = (
    await db
      .from("order_payments")
      .select("cora_invoice_id,pix_qr_code,boleto_url,boleto_digitable")
      .eq("order_id", intent.order_id)
      .single()
  ).data!;
  const repeated = await createInvoice(intent.invoice_input, intent.idempotency_key);
  assert.equal(repeated.id, payment.cora_invoice_id, "IDEMPOTENCY_FAILED");
  assert.ok(payment.pix_qr_code, "PIX_NOT_AVAILABLE");
  const { SupabaseBotServices } = await import("../src/lib/whatsapp/repository");
  const { processConversation } = await import("../src/lib/whatsapp/engine");
  const services = new SupabaseBotServices(db);
  const context = { eventId: "stage-pix", conversationId: cv.id, contactId: cv.contact_id,
    customerId: CUSTOMER_A, version: 1, text: "pix" };
  const list = await processConversation(context, {}, services);
  const selected = await processConversation({ ...context, version: 2,
    text: `v${list.state.menuVersion}:pix:${intent.order_id}` }, list.state, services);
  assert.ok(selected.replies.some((reply) => reply.type === "text" && reply.text === payment.pix_qr_code), "BOT_PIX_NOT_AVAILABLE");
  console.log("Cobrança persistida; repetição recuperou a mesma referência. Simulando pagamento em stage.");
  await simulatePaymentInStage(payment.cora_invoice_id);
  let paymentStatus = "";
  let orderStatus: string | null = null;
  for (let i = 0; i < 12; i++) {
    const sync = await syncInvoiceStatus(payment.cora_invoice_id, db);
    paymentStatus = sync?.paymentStatus ?? "";
    orderStatus = sync?.orderStatus ?? null;
    if (paymentStatus === "paid") break;
    await setTimeout(2000);
  }
  assert.equal(paymentStatus, "paid", "STAGE_PAYMENT_NOT_CONFIRMED");
  assert.equal(orderStatus, "paid");
  const report = {
    environment: "stage",
    database: "local-isolated",
    amountCents: 500,
    orderId: intent.order_id,
    invoiceId: payment.cora_invoice_id,
    hasPix: !!payment.pix_qr_code,
    botReturnsSamePix: true,
    hasBoleto: !!payment.boleto_url,
    hasDigitable: !!payment.boleto_digitable,
    sameInvoiceOnRetry: true,
    paymentStatus,
    orderStatus,
    whatsappMessagesSent: 0
  };
  await writeFile("/tmp/pontalti-whatsapp-cora-stage-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error("Teste stage falhou:", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
