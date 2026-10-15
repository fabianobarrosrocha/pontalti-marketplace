"use server";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/catalog-shared";
import { syncInvoiceStatus } from "@/lib/cora/payment-sync";
import { getSupabaseService } from "@/lib/supabase/service";
import { prepareCheckout, issueCheckoutPayment, issueBalanceCheckout, syncBalanceCheckout, renewBalanceConsent, balancePurchaseNeedsReview } from "@/lib/commerce/checkout";
import { getCustomerBalance, type CustomerBalance } from "@/lib/commerce/customer-finance";

export type CreateOrderResult = { ok: true; orderId: string } | { ok: false; error: string };

export async function createOrder(input: {
  addressId: string;
  cartVersion: number;
  subtotalCents: number;
  notes?: string;
  paymentMethod?: "cora" | "account_balance";
  balanceConsent?: { account_revision: number; projected_balance_cents: number };
}): Promise<CreateOrderResult> {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sessão expirada — faça login novamente." };
  if (
    !isUuid(input.addressId) ||
    !Number.isSafeInteger(input.cartVersion) ||
    !Number.isSafeInteger(input.subtotalCents)
  ) {
    return { ok: false, error: "Revise os itens e selecione um endereço." };
  }
  try {
    const intent = await prepareCheckout({ ...input, customerId: user.id, origin: "website" });
    try {
      if (input.paymentMethod === "account_balance") await issueBalanceCheckout(intent.id);
      else await issueCheckoutPayment(intent.id);
    } catch {
      /* Pedido reservado; o worker recupera a emissão. */
    }
    return { ok: true, orderId: intent.order_id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Não foi possível concluir o pedido." };
  }
}

export async function readAccountBalance(): Promise<{ ok: true; summary: CustomerBalance } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sessão expirada. Entre novamente." };
  try { return { ok: true, summary: await getCustomerBalance(user.id) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Saldo indisponível." }; }
}

export async function confirmUpdatedBalance(orderId: string, consent: { account_revision: number; projected_balance_cents: number }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(orderId)) return { ok: false, error: "Pedido não encontrado." };
  try {
    await renewBalanceConsent(orderId, user.id, consent);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Não foi possível confirmar o novo saldo." };
  }
}

export async function readOrderAccountBalance(orderId: string): Promise<
  { ok: true; summary: CustomerBalance; ownReservedCents: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(orderId)) return { ok: false, error: "Pedido não encontrado." };
  try {
    const purchase = await syncBalanceCheckout(orderId, user.id);
    const summary = await getCustomerBalance(user.id);
    return { ok: true, summary, ownReservedCents: purchase?.status === "PENDING" ? purchase.reserved_cents : 0 };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Não foi possível consultar o saldo." }; }
}

export type PaymentCheckResult = { ok: true; status: string; orderStatus: string } | { ok: false; error: string };

/**
 * Verifica o pagamento de um pedido do PRÓPRIO cliente, consultando a Cora.
 * Usado pelo polling da tela de pagamento (funciona mesmo sem webhook público).
 */
export async function checkPaymentStatus(orderId: string): Promise<PaymentCheckResult> {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user || !isUuid(orderId)) return { ok: false, error: "Sessão expirada." };

  // RLS garante que só o dono enxerga o pedido/pagamento.
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, status, payment_method, order_payments(cora_invoice_id, status)")
    .eq("id", orderId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!order) return { ok: false, error: "Pedido não encontrado." };
  if (order.payment_method === "account_balance") {
    let purchase;
    try { purchase = await syncBalanceCheckout(order.id, user.id); } catch { /* Truthful known status while recovering. */ }
    const fresh = await supabase.from("orders").select("status").eq("id", orderId).single();
    const intent = await getSupabaseService().from("checkout_intents").select("status").eq("order_id", orderId).eq("customer_id", user.id).maybeSingle();
    return { ok: true, status: intent.data?.status === "balance_review" || balancePurchaseNeedsReview(purchase) ? "balance_review" : fresh.data?.status ?? order.status,
      orderStatus: fresh.data?.status ?? order.status };
  }

  const payment = (order.order_payments as { cora_invoice_id: string; status: string }[] | null)?.[0];
  if (!payment) {
    const pending = await getSupabaseService()
      .from("checkout_intents")
      .select("id, status")
      .eq("order_id", orderId)
      .eq("customer_id", user.id)
      .maybeSingle();
    if (pending.data?.status === "review") return { ok: true, status: "pending_review", orderStatus: order.status };
    if (pending.data) {
      try {
        const result = await issueCheckoutPayment(pending.data.id);
        if (result === "review") return { ok: true, status: "pending_review", orderStatus: order.status };
      } catch {
        /* Mantém o pedido consultável durante indisponibilidade. */
      }
    }
    return { ok: true, status: "pending_issue", orderStatus: order.status };
  }

  if (order.status !== "awaiting_payment" || payment.status === "paid") {
    return { ok: true, status: payment.status, orderStatus: order.status };
  }

  try {
    const sync = await syncInvoiceStatus(payment.cora_invoice_id);
    return {
      ok: true,
      status: sync?.paymentStatus ?? payment.status,
      orderStatus: sync?.orderStatus ?? order.status
    };
  } catch {
    // Cora indisponível — devolve o estado conhecido sem quebrar o polling.
    return { ok: true, status: payment.status, orderStatus: order.status };
  }
}
