import "server-only";
import { randomUUID } from "node:crypto";
import { cpf } from "cpf-cnpj-validator";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/supabase/service";
import { createInvoice, type CreateInvoiceInput } from "@/lib/cora/client";
import { customerFinanceEnvironment, financeRequest, linkFinanceCustomer, type BalancePurchase, type FinanceEnvironment } from "./customer-finance";

export type CheckoutIntent = {
  id: string;
  order_id: string;
  customer_id: string;
  idempotency_key: string;
  invoice_input: CreateInvoiceInput;
  status: "pending" | "issuing" | "ready" | "review" | "balance_pending" | "balance_ready" | "balance_review";
  first_attempt_at: string | null;
  payment_method?: "cora" | "account_balance";
  finance_environment?: FinanceEnvironment | null;
  core_purchase_id?: string | null;
  finance_consent?: { account_revision: number; projected_balance_cents: number } | null;
};

const messages: Record<string, string> = {
  EMPTY_CART: "Seu carrinho está vazio.",
  CART_CHANGED: "O carrinho mudou. Revise os itens antes de confirmar novamente.",
  PRICE_CHANGED: "O preço mudou. Revise o novo total antes de confirmar.",
  PROFILE_INCOMPLETE: "Complete seu nome e CPF em Meus dados para gerar o pagamento.",
  ADDRESS_UNAVAILABLE: "Selecione um endereço da sua conta.",
  PRODUCT_UNAVAILABLE: "Um produto não está disponível. Revise o carrinho.",
  MINIMUM_ORDER: "O valor mínimo do pedido é R$ 5,00.",
  DELIVERY_CHANGED: "As condições de entrega mudaram. Revise antes de confirmar.",
  DELIVERY_NOT_CONFIGURED:
    "As condições de venda pelo WhatsApp ainda não estão disponíveis. Seu carrinho foi preservado.",
  ADDRESS_NOT_SERVED: "A modalidade disponível não atende esse endereço. Escolha outro endereço.",
  PAYMENT_METHOD_CHANGED: "Este carrinho já gerou um pedido com outra forma de pagamento. Consulte Meus pedidos."
};
export function commerceError(code: string): string {
  return messages[code] ?? "Não foi possível concluir. Tente novamente em instantes.";
}

export async function prepareCheckout(
  input: {
    customerId: string;
    addressId: string;
    cartVersion: number;
    subtotalCents: number;
    origin: "website" | "whatsapp";
    conversationId?: string;
    notes?: string;
    feeCents?: number;
    delivery?: string;
    paymentMethod?: "cora" | "account_balance";
    balanceConsent?: { account_revision: number; projected_balance_cents: number };
  },
  db: SupabaseClient = getSupabaseService()
): Promise<CheckoutIntent> {
  const profile = await db.from("customers").select("cpf").eq("id", input.customerId).maybeSingle();
  if (profile.error) throw new Error("Não foi possível verificar o cadastro.");
  if (!cpf.isValid(profile.data?.cpf ?? "")) throw new Error(commerceError("PROFILE_INCOMPLETE"));
  const accountBalance = input.paymentMethod === "account_balance";
  if (accountBalance && (!input.balanceConsent || !Number.isSafeInteger(input.balanceConsent.account_revision) ||
    input.balanceConsent.account_revision < 0 || !Number.isSafeInteger(input.balanceConsent.projected_balance_cents)))
    throw new Error("Revise o saldo e o valor previsto antes de confirmar.");
  if (accountBalance) await linkFinanceCustomer(input.customerId, db);
  const { data, error } = await db.rpc("commerce_prepare_checkout", {
    p_customer_id: input.customerId,
    p_address_id: input.addressId,
    p_cart_version: input.cartVersion,
    p_expected_subtotal_cents: input.subtotalCents,
    p_origin: input.origin,
    p_conversation_id: input.conversationId ?? null,
    p_expected_fee_cents: input.feeCents ?? 0,
    p_expected_delivery: input.delivery ?? "Envio a combinar",
    p_notes: input.notes?.trim().slice(0, 1000) || null,
    p_payment_method: input.paymentMethod ?? "cora",
    p_finance_environment: accountBalance ? customerFinanceEnvironment() : null,
    p_balance_consent: accountBalance ? input.balanceConsent : null
  });
  if (error) throw new Error(commerceError(error.message));
  return data as CheckoutIntent;
}

/** A referência, os dados e a chave Cora são persistidos antes da chamada. */
export async function issueCheckoutPayment(
  intentId: string,
  db: SupabaseClient = getSupabaseService(),
  gateway: typeof createInvoice = createInvoice
): Promise<"ready" | "pending" | "review"> {
  const source = await db.from("checkout_intents").select("payment_method").eq("id", intentId).single();
  if (source.error) throw new Error("Intenção de compra não encontrada.");
  if (source.data.payment_method === "account_balance") throw new Error("Este pedido usa saldo na conta.");
  const token = randomUUID();
  const { data, error } = await db.rpc("commerce_claim_checkout", { p_intent_id: intentId, p_token: token });
  if (error) throw new Error("Falha ao recuperar a emissão de pagamento.");
  const intent = data as CheckoutIntent | null;
  if (!intent?.id) {
    const result = await db.from("checkout_intents").select("status").eq("id", intentId).single();
    if (result.error) throw new Error("Intenção de compra não encontrada.");
    return result.data.status === "ready" ? "ready" : result.data.status === "review" ? "review" : "pending";
  }
  // Não presumir retenção ilimitada de idempotência pelo banco.
  if (intent.first_attempt_at && Date.now() - Date.parse(intent.first_attempt_at) > 10 * 60_000) {
    const result = await db
      .from("checkout_intents")
      .update({ status: "review", error: "RECONCILIATION_REQUIRED", lease_token: null, lease_until: null })
      .eq("id", intent.id)
      .eq("lease_token", token);
    if (result.error) throw new Error("Falha ao registrar conciliação pendente.");
    return "review";
  }
  try {
    const invoice = await gateway(intent.invoice_input, intent.idempotency_key);
    const result = await db.rpc("commerce_finish_checkout", {
      p_intent_id: intent.id,
      p_token: token,
      p_invoice: invoice
    });
    if (result.error) throw new Error("Falha ao persistir cobrança.");
    return "ready";
  } catch {
    // Um timeout pode ter criado a cobrança. Preservar pedido e chave original.
    const result = await db
      .from("checkout_intents")
      .update({
        status: "pending",
        error: "ISSUE_RESULT_PENDING",
        lease_token: null,
        lease_until: null,
        next_attempt_at: new Date(Date.now() + 30_000).toISOString()
      })
      .eq("id", intent.id)
      .eq("lease_token", token);
    if (result.error) throw new Error("Falha ao registrar emissão pendente.");
    return "pending";
  }
}

/** Durable Supabase intent + stable core idempotency recover failures between the two databases. */
export async function issueBalanceCheckout(
  intentId: string,
  db: SupabaseClient = getSupabaseService(),
  request: typeof financeRequest = financeRequest
): Promise<BalancePurchase> {
  const { data: intent, error } = await db.from("checkout_intents")
    .select("id,order_id,customer_id,idempotency_key,payment_method,finance_environment,invoice_input,finance_consent,finance_order_snapshot")
    .eq("id", intentId).single();
  if (error || intent?.payment_method !== "account_balance" ||
      !["STAGE", "PRODUCTION"].includes(intent.finance_environment))
    throw new Error("Pedido de saldo não encontrado.");
  const { data: order, error: orderError } = await db.from("orders")
    .select("id,total")
    .eq("id", intent.order_id).eq("customer_id", intent.customer_id).single();
  if (orderError || !order) throw new Error("Pedido não encontrado.");
  if (!intent.finance_order_snapshot?.items?.length) throw new Error("O pedido precisa de revisão antes de usar o saldo.");
  let purchase: BalancePurchase;
  try { purchase = await request<BalancePurchase>("/purchases", {
    idempotency_key: intent.idempotency_key,
    external_customer_id: intent.customer_id,
    external_order_id: intent.order_id,
    amount_cents: Math.round(Number(order.total) * 100),
    environment: intent.finance_environment,
    expected_account_revision: intent.finance_consent?.account_revision,
    expected_projected_balance_cents: intent.finance_consent?.projected_balance_cents,
    order_snapshot: intent.finance_order_snapshot
  }); } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["ACCOUNT_CHANGED", "BALANCE_CHANGED", "CUSTOMER_BALANCE_CHANGED"].includes(String(error.code))) {
      await db.from("checkout_intents").update({ status: "balance_review", error: "ACCOUNT_CHANGED" }).eq("id", intent.id);
    }
    throw error;
  }
  await applyBalancePurchase(intentId, purchase, db);
  return purchase;
}

export async function renewBalanceConsent(orderId: string, customerId: string,
  consent: { account_revision: number; projected_balance_cents: number }, db: SupabaseClient = getSupabaseService()) {
  if (!Number.isSafeInteger(consent?.account_revision) || consent.account_revision < 0 ||
    !Number.isSafeInteger(consent.projected_balance_cents)) throw new Error("Revise os valores antes de confirmar.");
  const current = await db.from("checkout_intents").select("id,status,core_purchase_id,finance_environment")
    .eq("order_id", orderId).eq("customer_id", customerId).eq("payment_method", "account_balance").maybeSingle();
  if (current.error || !current.data) throw new Error("Pedido não encontrado.");
  if (current.data.core_purchase_id) {
    const purchase = await financeRequest<BalancePurchase>("/purchases/by-order/" + encodeURIComponent(orderId) + "?environment=" + current.data.finance_environment);
    if (purchase.external_customer_id !== customerId || purchase.status !== "PENDING")
      throw new Error("Consulte a situação atual do pedido antes de confirmar.");
    const renewed = await financeRequest<BalancePurchase>("/purchases/" + purchase.id + "/renew-consent", {
      environment: current.data.finance_environment, version: purchase.version,
      expected_account_revision: consent.account_revision,
      expected_projected_balance_cents: consent.projected_balance_cents
    });
    await applyBalancePurchase(current.data.id, renewed, db);
    return renewed;
  }
  const { data, error } = await db.from("checkout_intents").update({ finance_consent: consent, status: "balance_pending", error: null })
    .eq("order_id", orderId).eq("customer_id", customerId).eq("payment_method", "account_balance")
    .eq("status", "balance_review").is("core_purchase_id", null).select("id").maybeSingle();
  if (error || !data) throw new Error("Consulte novamente a situação do pedido antes de confirmar.");
  return issueBalanceCheckout(data.id, db);
}

export function balancePurchaseNeedsReview(purchase: BalancePurchase | null | undefined) {
  return purchase?.status === "PENDING" && purchase.summary && typeof purchase.consented_projected_balance_cents === "number"
    ? purchase.summary.available_cents + purchase.reserved_cents - purchase.amount_cents < purchase.consented_projected_balance_cents
    : false;
}

export async function applyBalancePurchase(intentId: string, purchase: BalancePurchase, db: SupabaseClient) {
  const applied = await db.rpc("commerce_apply_balance_purchase", { p_intent_id: intentId, p_purchase: purchase });
  if (applied.error) throw new Error("A decisão foi preservada. A atualização do pedido será recuperada automaticamente.");
}

export async function syncBalanceCheckout(orderId: string, customerId: string, db: SupabaseClient = getSupabaseService()) {
  const { data, error } = await db.from("checkout_intents").select("id,status,core_purchase_id,finance_environment")
    .eq("order_id", orderId).eq("customer_id", customerId).eq("payment_method", "account_balance").maybeSingle();
  if (error) throw new Error("Falha ao consultar o pedido.");
  if (!data) return null;
  if (data.status === "balance_review") return null;
  if (!data.core_purchase_id) return issueBalanceCheckout(data.id, db);
  const purchase = await financeRequest<BalancePurchase>("/purchases/by-order/" + encodeURIComponent(orderId) +
    "?environment=" + data.finance_environment);
  await applyBalancePurchase(data.id, purchase, db);
  return purchase;
}
