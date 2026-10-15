import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/supabase/service";
import { createInvoice, getInvoice } from "@/lib/cora/client";
import { issueCheckoutPayment, syncBalanceCheckout } from "@/lib/commerce/checkout";
import { syncInvoiceStatus } from "@/lib/cora/payment-sync";
import { syncCustomerDepositNotifications } from "@/lib/commerce/customer-finance";
import { notifyOrderCreated, notifyPaymentConfirmed, notifyPaymentExpired } from "@/lib/notifications/events";
import { processConversation } from "./engine";
import { SupabaseBotServices } from "./repository";
import type { SendOutcome } from "./evolution";
import { catalogSender } from "./catalog-presentation";
import type { BotMessage, BotServices, BotState } from "./types";

type Dependencies = {
  db: SupabaseClient;
  services: BotServices;
  account: string;
  send: (account: string, waId: string, message: BotMessage) => Promise<SendOutcome>;
  invoiceCreate: typeof createInvoice;
  invoiceGet: typeof getInvoice;
  notify: (event: string, orderId: string, skipWhatsApp: boolean) => Promise<void>;
};
export function workerDependencies(): Dependencies {
  const db = getSupabaseService();
  return {
    db,
    services: new SupabaseBotServices(db),
    account: process.env.EVOLUTION_INSTANCE ?? "",
    send: catalogSender(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
    invoiceCreate: createInvoice,
    invoiceGet: getInvoice,
    notify: async (event, id, skip) => {
      if (event === "order_created") await notifyOrderCreated(id, skip);
      if (event === "payment_confirmed") await notifyPaymentConfirmed(id, skip);
      if (event === "payment_expired") await notifyPaymentExpired(id);
    }
  };
}

const checked = (error: unknown) => {
  if (error) throw new Error("WORKER_PERSISTENCE_FAILED");
};

export async function processInbox(deps: Dependencies): Promise<boolean> {
  const token = randomUUID();
  const { data, error } = await deps.db.rpc("whatsapp_claim_event", { p_token: token });
  checked(error);
  if (!data) return false;
  const { event, conversation, contact } = data as {
    event: { id: string; text: string };
    conversation: { id: string; version: number; state: BotState };
    contact: { id: string; account: string; customer_id: string | null };
  };
  try {
    if (contact.account !== deps.account) throw new Error("INSTANCE_MISMATCH");
    const result = await processConversation(
      {
        eventId: event.id,
        conversationId: conversation.id,
        contactId: contact.id,
        customerId: contact.customer_id,
        version: Number(conversation.version),
        text: event.text
      },
      conversation.state,
      deps.services
    );
    const completed = await deps.db.rpc("whatsapp_complete_event", {
      p_event_id: event.id,
      p_token: token,
      p_state: result.state,
      p_replies: result.replies
    });
    checked(completed.error);
  } catch {
    const retry = await deps.db.rpc("whatsapp_retry_event", { p_event_id: event.id, p_token: token });
    checked(retry.error);
  }
  return true;
}

export async function processOutbox(deps: Dependencies): Promise<boolean> {
  const token = randomUUID();
  const { data, error } = await deps.db.rpc("whatsapp_claim_outbox", { p_token: token });
  checked(error);
  if (!data) return false;
  const { message, contact } = data as {
    message: { id: string; content: BotMessage };
    contact: { account: string; wa_id: string; customer_id: string | null };
  };
  const authorized = !message.content.customerId || message.content.customerId === contact.customer_id;
  const outcome = authorized
    ? await deps.send(contact.account, contact.wa_id, message.content)
    : { status: "cancelled", error: "ACCOUNT_UNLINKED" };
  const finished = await deps.db.rpc("whatsapp_finish_outbox", {
    p_id: message.id,
    p_token: token,
    p_status: outcome.status,
    p_external_id: "providerMessageId" in outcome ? outcome.providerMessageId ?? null : null,
    p_error: outcome.error ?? null
  });
  checked(finished.error);
  return true;
}

export async function processPayments(deps: Dependencies) {
  const pending = await deps.db
    .from("checkout_intents")
    .select("id")
    .in("status", ["pending", "issuing"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(1);
  checked(pending.error);
  for (const intent of pending.data ?? []) await issueCheckoutPayment(intent.id, deps.db, deps.invoiceCreate);
  const balances = await deps.db.from("checkout_intents").select("id,order_id,customer_id")
    .eq("payment_method", "account_balance").in("status", ["balance_pending", "balance_ready"])
    .or("core_purchase_status.is.null,core_purchase_status.in.(PENDING,APPROVED)")
    .lte("next_attempt_at", new Date().toISOString()).order("next_attempt_at").limit(1);
  checked(balances.error);
  for (const intent of balances.data ?? []) {
    try { await syncBalanceCheckout(intent.order_id, intent.customer_id, deps.db); }
    catch { /* Never infer a decision while the core is unavailable. */ }
    const scheduled = await deps.db.from("checkout_intents").update({ next_attempt_at: new Date(Date.now() + 30_000).toISOString() }).eq("id", intent.id);
    checked(scheduled.error);
  }
  const open = await deps.db
    .from("order_payments")
    .select("id,cora_invoice_id")
    .in("status", ["open", "in_payment"])
    .or("last_check_attempt_at.is.null,last_check_attempt_at.lt." + new Date(Date.now() - 60_000).toISOString())
    .order("last_check_attempt_at", { nullsFirst: true })
    .limit(1);
  checked(open.error);
  for (const payment of open.data ?? []) {
    const attempted = await deps.db
      .from("order_payments")
      .update({ last_check_attempt_at: new Date().toISOString() })
      .eq("id", payment.id);
    checked(attempted.error);
    try {
      await syncInvoiceStatus(payment.cora_invoice_id, deps.db, deps.invoiceGet);
    } catch {
      /* Próxima passagem recupera a consulta; nenhum status é inventado. */
    }
  }
}

export async function processNotification(deps: Dependencies): Promise<boolean> {
  const token = randomUUID();
  const { data, error } = await deps.db.rpc("commerce_claim_notification", { p_token: token, p_account: deps.account });
  checked(error);
  if (!data) return false;
  await deps.notify(data.event, data.orderId, data.skipWhatsApp);
  const completed = await deps.db
    .from("commerce_notification_events")
    .update({ status: "done", lease_token: null, lease_until: null })
    .eq("id", data.id)
    .eq("lease_token", token);
  checked(completed.error);
  return true;
}

export async function workerTick(deps: Dependencies) {
  for (let i = 0; i < 20 && (await processInbox(deps)); i++) {
    /* Consome entradas ordenadas. */
  }
  for (let i = 0; i < 40 && (await processOutbox(deps)); i++) {
    /* Transporte separado da regra de compra. */
  }
  await processPayments(deps);
  try { await syncCustomerDepositNotifications(deps.db, deps.account); }
  catch { /* Core outage never invents a receipt; the next tick recovers the notice. */ }
  for (let i = 0; i < 20 && (await processNotification(deps)); i++) {
    /* Avisos duráveis. */
  }
  for (let i = 0; i < 40 && (await processOutbox(deps)); i++) {
    /* Confirmações sem esperar a próxima passagem. */
  }
}
