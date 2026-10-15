import "server-only";
import { createHmac, createHash } from "node:crypto";
import { cpf } from "cpf-cnpj-validator";
import { addressSchema, profileSchema, type AddressInput } from "@/lib/validation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/supabase/service";
import { CATALOG_SELECT, mapCatalogConfig, type CatalogConfigRow } from "@/lib/catalog-shared";
import { prepareCheckout, issueCheckoutPayment, issueBalanceCheckout, syncBalanceCheckout, renewBalanceConsent, balancePurchaseNeedsReview, commerceError } from "@/lib/commerce/checkout";
import { getCustomerBalance, getCustomerStatement, createBalanceDeposit, listBalanceDeposits, createDepositClaim } from "@/lib/commerce/customer-finance";
import { CustomerActionError } from "./types";
import { syncInvoiceStatus } from "@/lib/cora/payment-sync";
import { createInvoice, getInvoice } from "@/lib/cora/client";
import { hashChallenge, hashToken, siteUrl } from "./security";
import type { BotServices, BotSettings, BotProduct, BotOrder, BotState, BotProfile, RepeatLine, Selection } from "./types";

export const BOT_CATALOG_PAGE_SIZE = 3;
const check = (error: unknown) => {
  if (error) throw new Error("O serviço está temporariamente indisponível. Tente novamente em instantes.");
};
function checkMutation(error: { message: string } | null) {
  if (!error) return;
  const messages: Record<string, string> = {
    ACCOUNT_UNLINKED: "O vínculo da conta mudou. Escreva conta para entrar novamente.",
    ADDRESS_UNAVAILABLE: "Endereço não encontrado na sua conta.",
    ORDER_UNAVAILABLE: "Pedido não encontrado na sua conta.",
    PRODUCT_UNAVAILABLE: "Um produto do pedido não está mais disponível. O carrinho foi preservado.",
    PRICE_CHANGED: "O preço mudou. Consulte o pedido e revise a repetição novamente.",
    QUANTITY_LIMIT: "A soma com seu carrinho ultrapassa 999 unidades por produto. Ajuste o carrinho antes de repetir.",
    INVALID_CUSTOMER_DATA: "Confira os dados cadastrais antes de salvar."
  };
  if (messages[error.message]) throw new CustomerActionError(messages[error.message]);
  check(error);
}

export function mapBotProduct(row: CatalogConfigRow, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL): BotProduct {
  const product = mapCatalogConfig(row, supabaseUrl);
  return {
    id: product.id,
    title: product.title,
    sku: product.sku,
    description: product.description,
    priceCents: Math.round(product.price * 100),
    imageUrl: product.images[0]?.url ?? null,
    url: siteUrl("/produtos/" + product.slug)
  };
}

type OrderRow = {
  id: string;
  status: string;
  total: number | string;
  delivery_description: string | null;
  balance_debt_cents?: number | string;
  order_payments: {
    status: string;
    pix_qr_code: string | null;
    boleto_url: string | null;
    boleto_digitable: string | null;
    due_date: string | null;
  }[];
};
const ORDER_SELECT =
  "id,status,total,delivery_description,balance_debt_cents,order_payments(status,pix_qr_code,boleto_url,boleto_digitable,due_date)";
function mapOrder(row: OrderRow): BotOrder {
  const payment = row.order_payments?.[0];
  return {
    id: row.id,
    status: row.status,
    totalCents: Math.round(Number(row.total) * 100),
    delivery: row.delivery_description,
    balanceDebtCents: Number(row.balance_debt_cents ?? 0),
    payment: payment
      ? {
          status: payment.status,
          pix: payment.pix_qr_code,
          boleto: payment.boleto_url,
          digitable: payment.boleto_digitable,
          dueDate: payment.due_date
        }
      : null
  };
}

export class SupabaseBotServices implements BotServices {
  constructor(
    private readonly db: SupabaseClient = getSupabaseService(),
    private readonly gateway = { createInvoice, getInvoice }
  ) {}
  accountUrl = siteUrl;
  finance = {
    summary: (customerId: string) => getCustomerBalance(customerId, this.db),
    statement: (customerId: string) => getCustomerStatement(customerId, this.db),
    deposits: (customerId: string) => listBalanceDeposits(customerId, this.db),
    deposit: (customerId: string, amountCents: number, operationId: string) =>
      createBalanceDeposit(customerId, amountCents, operationUuid(operationId), this.db),
    claim: (customerId: string, input: { amountCents: number; depositedAt: string; reference: string }, operationId: string) =>
      createDepositClaim(customerId, { ...input, idempotencyKey: operationUuid(operationId) }, this.db),
    renewConsent: async (customerId: string, orderId: string, consent: { account_revision: number; projected_balance_cents: number }) => {
      await renewBalanceConsent(orderId, customerId, consent, this.db);
    },
    checkout: async (customerId: string, preview: NonNullable<BotState["preview"]>, conversationId: string) => {
      const intent = await prepareCheckout({ customerId, ...preview, origin: "whatsapp", conversationId,
        paymentMethod: "account_balance" }, this.db);
      let status = "PENDING";
      try { status = (await issueBalanceCheckout(intent.id, this.db)).status; }
      catch { /* Intent is durable; worker recovers without another order or debit. */ }
      return { orderId: intent.order_id, status };
    }
  };
  async settings(): Promise<BotSettings> {
    const { data, error } = await this.db.from("whatsapp_settings").select("key,value");
    check(error);
    const settings = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
    const delivery = settings.delivery;
    return {
      unitLabel: typeof settings.unit_label === "string" ? settings.unit_label : "",
      delivery: {
        enabled:
          delivery?.enabled === true &&
          Number.isSafeInteger(delivery?.feeCents) &&
          delivery.feeCents >= 0 &&
          Array.isArray(delivery?.states),
        description: String(delivery?.description ?? ""),
        feeCents: Number.isSafeInteger(delivery?.feeCents) && delivery.feeCents >= 0 ? delivery.feeCents : 0,
        states: Array.isArray(delivery?.states)
          ? delivery.states.filter((state: unknown) => typeof state === "string")
          : []
      }
    };
  }
  async catalog(query: string, page: number) {
    let request = this.db
      .from("product_marketplace_config")
      .select(CATALOG_SELECT)
      .eq("is_visible", true)
      .gt("display_price", 0)
      .order("display_order")
      .order("id");
    if (query) request = request.ilike("display_title", "%" + query.replace(/[%_]/g, "") + "%");
    const start = Math.max(0, Math.min(1000, page)) * BOT_CATALOG_PAGE_SIZE;
    const { data, error } = await request.range(start, start + BOT_CATALOG_PAGE_SIZE);
    check(error);
    const rows = (data ?? []) as CatalogConfigRow[];
    return { products: rows.slice(0, BOT_CATALOG_PAGE_SIZE).map((row) => mapBotProduct(row)), hasMore: rows.length > BOT_CATALOG_PAGE_SIZE };
  }
  async products(ids: string[]) {
    if (!ids.length) return [];
    const { data, error } = await this.db
      .from("product_marketplace_config")
      .select(CATALOG_SELECT)
      .eq("is_visible", true)
      .gt("display_price", 0)
      .in("id", ids);
    check(error);
    return ((data ?? []) as CatalogConfigRow[]).map((row) => mapBotProduct(row));
  }
  async cart(customerId: string) {
    const { data, error } = await this.db
      .from("carts")
      .select("version,cart_items(product_config_id,quantity)")
      .eq("customer_id", customerId)
      .maybeSingle();
    check(error);
    const lines = (data?.cart_items ?? []) as { product_config_id: string; quantity: number }[];
    const products = await this.products(lines.map((line) => line.product_config_id));
    const items = lines.map((line) => {
      const product = products.find((p) => p.id === line.product_config_id);
      return {
        productId: line.product_config_id,
        quantity: line.quantity,
        title: product?.title ?? "Produto indisponível",
        priceCents: product?.priceCents ?? 0,
        available: !!product
      };
    });
    return {
      version: Number(data?.version ?? 0),
      items,
      subtotalCents: items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0)
    };
  }
  async mutateCart(customerId: string, items: Selection[], mode: "increment" | "set" | "clear", operationId: string) {
    const result = await this.db.rpc("commerce_mutate_cart", {
      p_customer_id: customerId,
      p_lines: items,
      p_mode: mode,
      p_operation_id: operationId
    });
    if (result.error?.message === "PRODUCT_UNAVAILABLE")
      throw new CustomerActionError(commerceError("PRODUCT_UNAVAILABLE"));
    check(result.error);
  }
  async profileComplete(customerId: string) {
    const { data, error } = await this.db.from("customers").select("full_name,cpf").eq("id", customerId).maybeSingle();
    check(error);
    return !!data?.full_name?.trim() && cpf.isValid(data?.cpf ?? "");
  }
  async profile(customerId: string): Promise<BotProfile> {
    const { data, error } = await this.db.from("customers").select("full_name,phone").eq("id", customerId).single();
    check(error);
    return { fullName: data!.full_name, phone: data!.phone };
  }
  async updateProfile(customerId: string, contactId: string, patch: Partial<BotProfile>, operationId: string) {
    const parsed = profileSchema.pick({ fullName: true, phone: true }).partial().safeParse({
      ...patch, ...(patch.phone === null ? { phone: "" } : {})
    });
    if (!parsed.success || !Object.keys(parsed.data).length)
      throw new CustomerActionError("Confira o nome e o telefone informados.");
    const { error } = await this.db.rpc("whatsapp_update_customer", {
      p_customer_id: customerId, p_contact_id: contactId, p_operation_id: operationId,
      p_kind: "profile", p_data: parsed.data
    });
    checkMutation(error);
  }
  async saveAddress(customerId: string, contactId: string, input: AddressInput, id: string | undefined, operationId: string) {
    const parsed = addressSchema.safeParse(input);
    if (!parsed.success) throw new CustomerActionError(parsed.error.issues[0].message);
    const { error } = await this.db.rpc("whatsapp_update_customer", {
      p_customer_id: customerId, p_contact_id: contactId, p_operation_id: operationId,
      p_kind: "address", p_data: parsed.data, p_address_id: id ?? null
    });
    checkMutation(error);
  }
  async addresses(customerId: string) {
    const { data, error } = await this.db
      .from("customer_addresses")
      .select("id,street,number,complement,neighborhood,city,state,zip_code,is_default")
      .eq("customer_id", customerId)
      .is("archived_at", null)
      .order("is_default", { ascending: false })
      .order("created_at")
      .limit(10);
    check(error);
    return (data ?? []).map((row) => ({
      id: row.id as string,
      state: row.state as string,
      label: row.street + ", " + row.number + (row.complement ? " · " + row.complement : "") +
        " · " + row.neighborhood + " · " + row.city + "/" + row.state + " · " + row.zip_code,
      details: {
        zipCode: row.zip_code as string, street: row.street as string, number: row.number as string,
        complement: (row.complement ?? "") as string, neighborhood: row.neighborhood as string,
        city: row.city as string, state: row.state as string, isDefault: row.is_default === true
      }
    }));
  }
  async repeatPreview(customerId: string, orderId: string): Promise<RepeatLine[] | null> {
    const { data, error } = await this.db.from("orders")
      .select("order_items(product_config_id,quantity)").eq("id", orderId).eq("customer_id", customerId).maybeSingle();
    check(error);
    if (!data) return null;
    const items = data.order_items as { product_config_id: string; quantity: number }[];
    const products = await this.products(items.map((item) => item.product_config_id));
    return items.map((item) => {
      const product = products.find((product) => product.id === item.product_config_id);
      return { productId: item.product_config_id, quantity: item.quantity, title: product?.title ?? "Produto indisponível",
        priceCents: product?.priceCents ?? 0, available: !!product };
    });
  }
  async repeatOrder(customerId: string, contactId: string, orderId: string, lines: RepeatLine[], operationId: string) {
    const { error } = await this.db.rpc("whatsapp_repeat_order", {
      p_customer_id: customerId, p_contact_id: contactId, p_order_id: orderId,
      p_lines: lines.map(({ productId, quantity, priceCents }) => ({ productId, quantity, priceCents })),
      p_operation_id: operationId
    });
    checkMutation(error);
  }
  async orders(customerId: string, options: { page?: number; awaitingPayment?: boolean } = {}) {
    let request = this.db
      .from("orders")
      .select(ORDER_SELECT)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (options.awaitingPayment) request = request.eq("status", "awaiting_payment");
    const start = Math.max(0, Math.min(1000, Math.floor(options.page || 0))) * 8;
    const { data, error } = await request.range(start, start + 8);
    check(error);
    return ((data ?? []) as unknown as OrderRow[]).map(mapOrder);
  }
  async order(customerId: string, orderId: string) {
    const { data, error } = await this.db
      .from("orders")
      .select(ORDER_SELECT)
      .eq("id", orderId)
      .eq("customer_id", customerId)
      .maybeSingle();
    check(error);
    if (!data) return null;
    let row = data as unknown as OrderRow;
    let purchase;
    if (row.status === "awaiting_balance_approval" || row.status === "balance_approved") {
      try { purchase = await syncBalanceCheckout(orderId, customerId, this.db); } catch { /* Known pending state is truthful. */ }
      const fresh = await this.db.from("orders").select(ORDER_SELECT).eq("id", orderId).eq("customer_id", customerId).maybeSingle();
      check(fresh.error);
      if (fresh.data) row = fresh.data as unknown as OrderRow;
    }
    if (row.status === "awaiting_payment") {
      const invoice = await this.db
        .from("order_payments")
        .select("cora_invoice_id")
        .eq("order_id", row.id)
        .maybeSingle();
      check(invoice.error);
      if (invoice.data) {
        try {
          await syncInvoiceStatus(invoice.data.cora_invoice_id, this.db, this.gateway.getInvoice);
        } catch {
          /* Mantém o estado conhecido; worker recupera. */
        }
        const fresh = await this.db
          .from("orders")
          .select(ORDER_SELECT)
          .eq("id", orderId)
          .eq("customer_id", customerId)
          .maybeSingle();
        check(fresh.error);
        return fresh.data ? mapOrder(fresh.data as unknown as OrderRow) : null;
      }
    }
    const mapped = mapOrder(row);
    if (row.status === "awaiting_balance_approval") {
      const intent = await this.db.from("checkout_intents").select("status").eq("order_id", orderId).eq("customer_id", customerId).maybeSingle();
      check(intent.error);
      mapped.balanceNeedsReview = intent.data?.status === "balance_review" || balancePurchaseNeedsReview(purchase);
      mapped.balanceReservedCents = purchase?.reserved_cents ?? 0;
    }
    return mapped;
  }
  async checkout(customerId: string, preview: NonNullable<BotState["preview"]>, conversationId: string) {
    const intent = await prepareCheckout({ customerId, ...preview, origin: "whatsapp", conversationId }, this.db);
    let status: string = "pending";
    try {
      status = await issueCheckoutPayment(intent.id, this.db, this.gateway.createInvoice);
    } catch {
      /* Pedido já reservado; preservar sua referência. */
    }
    return { orderId: intent.order_id, status };
  }
  async createLink(contactId: string, operationId: string) {
    const secret = process.env.WHATSAPP_LINK_SECRET ?? process.env.WHATSAPP_WEBHOOK_SECRET;
    if (!secret || secret.length < 32) throw new Error("Vinculação temporariamente indisponível.");
    const token = createHmac("sha256", secret)
      .update(contactId + ":" + operationId)
      .digest("hex");
    const { error } = await this.db.from("whatsapp_account_links").upsert(
      {
        contact_id: contactId,
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
      },
      { onConflict: "token_hash", ignoreDuplicates: true }
    );
    check(error);
    return siteUrl("/conta/whatsapp/vincular/" + token);
  }
  async confirmLink(contactId: string, code: string, eventId: string) {
    const { data, error } = await this.db
      .from("whatsapp_account_links")
      .select("token_hash")
      .eq("contact_id", contactId)
      .is("confirmed_at", null)
      .gt("expires_at", new Date().toISOString())
      .not("customer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(error);
    const result = await this.db.rpc("whatsapp_confirm_link", {
      p_contact_id: contactId,
      p_challenge_hash: data ? hashChallenge(data.token_hash, code) : "invalid",
      p_event_id: eventId
    });
    check(result.error);
    return result.data as string | null;
  }
  async unlink(contactId: string) {
    const { error } = await this.db.rpc("whatsapp_unlink", { p_contact_id: contactId });
    check(error);
  }
  async articles() {
    const { data, error } = await this.db
      .from("support_articles")
      .select("id,title,answer")
      .eq("enabled", true)
      .order("display_order")
      .limit(20);
    check(error);
    return (data ?? []) as { id: string; title: string; answer: string }[];
  }
}

/** Stable across worker retries, namespaced separately from bank invoice keys. */
function operationUuid(operationId: string) {
  const hash = createHash("sha256").update("pontalti-customer-finance:" + operationId).digest("hex");
  return hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-4" + hash.slice(13, 16) + "-a" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
}
