import "server-only";
import { getSupabaseService } from "@/lib/supabase/service";
import { escapeHtml, sendTelegramMessage } from "./telegram";
import { sendWhatsAppTemplate, toWhatsAppNumber, WHATSAPP_TEMPLATES } from "./whatsapp";
import { logNotification } from "./log";

// Eventos de negócio do marketplace → Telegram (interno) + WhatsApp (cliente).
// Todas as funções engolem os próprios erros: notificação nunca pode quebrar
// checkout, webhook ou polling.

const formatBRL = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

const shortId = (id: string) => id.slice(0, 8);

const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] || "cliente";

// due_date vem como "YYYY-MM-DD" — formata sem passar por Date (evita fuso).
const formatDateBR = (isoDate: string) => {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : isoDate;
};

// Relações embutidas do PostgREST podem vir como objeto ou array de 1.
const one = <T>(rel: T | T[] | null | undefined): T | null => (Array.isArray(rel) ? rel[0] ?? null : rel ?? null);

type OrderContext = {
  total: number;
  customerName: string;
  phone: string | null;
  dueDate: string | null;
};

async function getOrderContext(orderId: string): Promise<OrderContext | null> {
  const { data, error } = await getSupabaseService()
    .from("orders")
    .select("id, total, customers(full_name, phone), order_payments(due_date)")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !data) return null;
  const customer = one(data.customers as { full_name?: string | null; phone?: string | null } | null);
  const payment = one(data.order_payments as { due_date?: string | null }[] | null);
  return {
    total: Number(data.total),
    customerName: customer?.full_name || "Cliente Marketplace",
    phone: customer?.phone ?? null,
    dueDate: payment?.due_date ?? null
  };
}

async function dispatch(input: {
  event: string;
  orderId: string;
  telegramText: string;
  whatsapp?: { phone: string | null; template: string; params: string[] } | null;
}): Promise<void> {
  const jobs: Promise<void>[] = [
    sendTelegramMessage(input.telegramText).then((outcome) =>
      logNotification({ channel: "telegram", event: input.event, orderId: input.orderId, outcome })
    )
  ];
  if (input.whatsapp) {
    const to = toWhatsAppNumber(input.whatsapp.phone);
    const send = to
      ? sendWhatsAppTemplate(to, input.whatsapp.template, input.whatsapp.params)
      : Promise.resolve({ status: "skipped" as const, error: "cliente sem telefone cadastrado" });
    jobs.push(
      send.then((outcome) =>
        logNotification({ channel: "whatsapp", event: input.event, orderId: input.orderId, recipient: to, outcome })
      )
    );
  }
  await Promise.all(jobs);
}

/** Pedido criado no checkout, cobrança Cora emitida (status awaiting_payment). */
export async function notifyOrderCreated(orderId: string, skipWhatsApp = false): Promise<void> {
  try {
    const ctx = await getOrderContext(orderId);
    if (!ctx) return;
    const num = `#${shortId(orderId)}`;
    const due = ctx.dueDate ? formatDateBR(ctx.dueDate) : null;
    const paymentUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002"}/checkout/pagamento/${orderId}`;
    await dispatch({
      event: "order_created",
      orderId,
      telegramText: [
        `🛒 <b>Novo pedido ${num}</b>`,
        `Cliente: ${escapeHtml(ctx.customerName)}`,
        `Total: ${formatBRL(ctx.total)}`,
        due ? `Vencimento da cobrança: ${due}` : null,
        `Status: aguardando pagamento`
      ]
        .filter(Boolean)
        .join("\n"),
      whatsapp: skipWhatsApp
        ? null
        : {
            phone: ctx.phone,
            template: WHATSAPP_TEMPLATES.orderCreated,
            params: [firstName(ctx.customerName), num, formatBRL(ctx.total), due ?? "3 dias", paymentUrl]
          }
    });
  } catch (e) {
    console.error("[notifications] notifyOrderCreated falhou:", e);
  }
}

/** Cobrança paga na Cora — pedido promovido para "paid" (webhook ou polling). */
export async function notifyPaymentConfirmed(orderId: string, skipWhatsApp = false): Promise<void> {
  try {
    const ctx = await getOrderContext(orderId);
    if (!ctx) return;
    const num = `#${shortId(orderId)}`;
    await dispatch({
      event: "payment_confirmed",
      orderId,
      telegramText: [
        `💰 <b>Pagamento confirmado — pedido ${num}</b>`,
        `Cliente: ${escapeHtml(ctx.customerName)}`,
        `Total: ${formatBRL(ctx.total)}`,
        `Próximo passo: registrar na fábrica pela central de pedidos.`
      ].join("\n"),
      whatsapp: skipWhatsApp
        ? null
        : {
            phone: ctx.phone,
            template: WHATSAPP_TEMPLATES.paymentConfirmed,
            params: [firstName(ctx.customerName), num]
          }
    });
  } catch (e) {
    console.error("[notifications] notifyPaymentConfirmed falhou:", e);
  }
}

/** Cobrança cancelada/vencida na Cora — pedido marcado como payment_expired. */
export async function notifyPaymentExpired(orderId: string): Promise<void> {
  try {
    const ctx = await getOrderContext(orderId);
    if (!ctx) return;
    await dispatch({
      event: "payment_expired",
      orderId,
      telegramText: [
        `⚠️ <b>Cobrança expirada — pedido #${shortId(orderId)}</b>`,
        `Cliente: ${escapeHtml(ctx.customerName)}`,
        `Total: ${formatBRL(ctx.total)}`
      ].join("\n")
    });
  } catch (e) {
    console.error("[notifications] notifyPaymentExpired falhou:", e);
  }
}
