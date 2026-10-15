import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/supabase/service";

export type FinanceEnvironment = "STAGE" | "PRODUCTION";
export type CustomerBalance = {
  customer_id: number;
  balance_cents: number;
  reserved_cents: number;
  available_cents: number;
  debts_cents: number;
  credit_limit_cents: number;
  environment: FinanceEnvironment;
  account_revision: number;
};
export type BalancePurchase = {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  version: number;
  amount_cents: number;
  reserved_cents: number;
  projected_balance_cents: number;
  requires_approval: boolean;
  external_order_id: string;
  customer_id: number;
  external_customer_id: string;
  environment: FinanceEnvironment;
  cash_applied_cents: number;
  core_order_id: number | null;
  consented_projected_balance_cents?: number;
  summary?: CustomerBalance;
};
export type DepositClaim = {
  id: string;
  amount_cents: number;
  status: "PENDING" | "OPEN" | "UNKNOWN" | "CREDITED" | "REJECTED";
  kind: "BANK_CLAIM" | "BOLETO";
  boleto_url: string | null;
  digitable: string | null;
  environment: FinanceEnvironment;
  external_customer_id: string;
};
export type CustomerAccountEntry = {
  id: string; kind: string; amount_cents: number; created_at: string; description?: string | null;
};

export class CustomerFinanceError extends Error {
  constructor(message: string, readonly code = "FINANCE_UNAVAILABLE") {
    super(message);
  }
}

/** Explicit environment: never infer production credit from the store's stage invoices. */
export function customerFinanceEnvironment(): FinanceEnvironment {
  const value = process.env.CUSTOMER_FINANCE_ENVIRONMENT;
  if (value !== "STAGE" && value !== "PRODUCTION")
    throw new CustomerFinanceError("O pagamento com saldo ainda não está disponível. Escolha Pix ou boleto.");
  return value;
}

export async function financeRequest<T>(path: string, body?: unknown): Promise<T> {
  const token = process.env.CUSTOMER_FINANCE_INTERNAL_TOKEN;
  const base = process.env.CORE_API_URL?.replace(/\/$/, "");
  if (!base || !token || token.length < 32)
    throw new CustomerFinanceError("O serviço de saldo está temporariamente indisponível.");
  let response: Response;
  try {
    response = await fetch(base + "/commerce-finance" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new CustomerFinanceError("Não foi possível consultar o saldo agora. Nenhum pagamento foi presumido.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof result?.code === "string" ? result.code : "FINANCE_UNAVAILABLE";
    const linking = ["CUSTOMER_LINK_PENDING", "LINK_PENDING", "CUSTOMER_NOT_LINKED", "LINK_REQUIRES_APPROVAL"].includes(code);
    throw new CustomerFinanceError(
      linking
        ? "A Pontalti precisa conferir o vínculo do seu cadastro antes de liberar o acesso ao saldo."
        : "Não foi possível concluir a operação de saldo. Consulte a Pontalti ou tente novamente.",
      code
    );
  }
  return result as T;
}

/** Identity comes exclusively from the authenticated customer record, never WhatsApp text. */
export async function linkFinanceCustomer(customerId: string, db: SupabaseClient = getSupabaseService()) {
  const { data, error } = await db.from("customers").select("full_name,cpf").eq("id", customerId).single();
  if (error || !data?.full_name || !data.cpf)
    throw new CustomerFinanceError("Complete seu nome e CPF em Meus dados antes de usar o saldo.");
  const addressResult = await db.from("customer_addresses")
    .select("zip_code,neighborhood,street,city,state,number,complement")
    .eq("customer_id", customerId).is("archived_at", null).order("is_default", { ascending: false }).order("created_at").limit(1).maybeSingle();
  if (addressResult.error) throw new CustomerFinanceError("Não foi possível consultar o cadastro. Tente novamente.");
  const address = addressResult.data;
  const link = await financeRequest<{ status: string }>("/customers/link", {
    external_customer_id: customerId,
    document: data.cpf.replace(/\D/g, ""),
    name: data.full_name,
    environment: customerFinanceEnvironment(),
    ...(address ? { address: { zip_code: address.zip_code, neighborhood: address.neighborhood, public_place: address.street,
      city: address.city, state: address.state, address_number: address.number, complement: address.complement ?? "" } } : {})
  });
  if (link.status !== "APPROVED") throw new CustomerFinanceError(
    "A Pontalti precisa conferir o vínculo do seu cadastro antes de liberar o acesso ao saldo.", "LINK_PENDING"
  );
}

export async function createBalanceDeposit(customerId: string, amountCents: number, key: string, db: SupabaseClient = getSupabaseService()) {
  await linkFinanceCustomer(customerId, db);
  const deposit = await financeRequest<DepositClaim>("/deposits", { idempotency_key: key, external_customer_id: customerId,
    amount_cents: amountCents, environment: customerFinanceEnvironment() });
  await rememberCustomerDeposit(customerId, deposit, db);
  return deposit;
}

export async function listBalanceDeposits(customerId: string, db: SupabaseClient = getSupabaseService()) {
  await linkFinanceCustomer(customerId, db);
  const deposits = await financeRequest<DepositClaim[]>("/customers/" + encodeURIComponent(customerId) +
    "/deposits?environment=" + customerFinanceEnvironment());
  for (const deposit of deposits) await rememberCustomerDeposit(customerId, deposit, db);
  return deposits;
}

export async function getCustomerBalance(customerId: string, db: SupabaseClient = getSupabaseService()) {
  await linkFinanceCustomer(customerId, db);
  return financeRequest<CustomerBalance>(
    "/customers/" + encodeURIComponent(customerId) + "/summary?environment=" + customerFinanceEnvironment()
  );
}

export async function getCustomerStatement(customerId: string, db: SupabaseClient = getSupabaseService()) {
  await linkFinanceCustomer(customerId, db);
  return financeRequest<CustomerAccountEntry[]>("/customers/" + encodeURIComponent(customerId) +
    "/statement?environment=" + customerFinanceEnvironment());
}

export async function createDepositClaim(
  customerId: string,
  input: { idempotencyKey: string; amountCents: number; depositedAt: string; reference: string },
  db: SupabaseClient = getSupabaseService()
) {
  await linkFinanceCustomer(customerId, db);
  const deposit = await financeRequest<DepositClaim>("/deposit-claims", {
    idempotency_key: input.idempotencyKey,
    external_customer_id: customerId,
    amount_cents: input.amountCents,
    deposited_at: input.depositedAt,
    reference: input.reference,
    environment: customerFinanceEnvironment()
  });
  await rememberCustomerDeposit(customerId, deposit, db);
  return deposit;
}

async function rememberCustomerDeposit(customerId: string, deposit: DepositClaim, db: SupabaseClient) {
  const { error } = await db.rpc("commerce_remember_customer_deposit", { p_customer_id: customerId, p_deposit: deposit });
  if (error) throw new CustomerFinanceError("A solicitação foi preservada. Consulte Meus depósitos novamente para acompanhar.");
}

/** Bank confirmation stays in the core; Supabase stores only the delivery reference. */
export async function syncCustomerDepositNotifications(db: SupabaseClient, account: string, request: typeof financeRequest = financeRequest) {
  const pending = await db.from("commerce_customer_deposit_refs").select("deposit_id,customer_id,environment")
    .neq("status", "REJECTED").or("status.neq.CREDITED,notified_at.is.null")
    .lte("next_check_at", new Date().toISOString()).order("next_check_at").limit(1);
  if (pending.error) throw new Error("Falha ao consultar avisos de depósitos.");
  for (const ref of pending.data ?? []) {
    try {
      let deposit = await request<DepositClaim>("/deposits/" + ref.deposit_id + "?environment=" + ref.environment);
      if (deposit.kind === "BOLETO" && ["OPEN", "UNKNOWN"].includes(deposit.status))
        deposit = await request<DepositClaim>("/deposits/" + ref.deposit_id + "/sync", { environment: ref.environment });
      if (deposit.id !== ref.deposit_id || deposit.external_customer_id !== ref.customer_id || deposit.environment !== ref.environment)
        throw new Error("Depósito não corresponde ao cadastro.");
      const applied = await db.rpc("commerce_notify_customer_deposit", { p_customer_id: ref.customer_id, p_deposit: deposit, p_account: account });
      if (applied.error) throw new Error("Falha ao registrar aviso de depósito.");
    } finally {
      await db.from("commerce_customer_deposit_refs").update({ next_check_at: new Date(Date.now() + 60_000).toISOString() }).eq("deposit_id", ref.deposit_id);
    }
  }
}
