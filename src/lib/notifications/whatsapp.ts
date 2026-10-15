import "server-only";
import type { NotifyOutcome } from "./telegram";

// Notificação ao cliente via WhatsApp Cloud API (Meta, oficial).
// Mensagens iniciadas pela empresa exigem TEMPLATE aprovado no Meta Business —
// os nomes abaixo precisam existir na WABA com idioma pt_BR (ver SETUP-BOTS.md).
// Sem credenciais configuradas, vira no-op com status "skipped".

const GRAPH_VERSION = "v23.0";
const TEMPLATE_LANGUAGE = "pt_BR";

export const WHATSAPP_TEMPLATES = {
  orderCreated: "pedido_recebido",
  paymentConfirmed: "pagamento_confirmado",
  orderUpdated: "pedido_atualizado_v2",
} as const;

// WHATSAPP_PROVIDER=evolution roteia os envios para uma Evolution API
// (não-oficial, SOMENTE teste — ver infra/evolution-test). Default: meta.
const provider = () => (process.env.WHATSAPP_PROVIDER ?? "meta").toLowerCase();

// No modo evolution não existem templates aprovados: o texto é montado aqui,
// espelhando os bodies cadastrados na Meta (SETUP-BOTS.md).
const TEMPLATE_TEXTS: Record<string, (p: string[]) => string> = {
  [WHATSAPP_TEMPLATES.orderCreated]: ([nome, num, valor, venc, link]) =>
    `Olá ${nome}! Recebemos seu pedido ${num} no valor de ${valor} na loja Pontalti. Para concluir, realize o pagamento (Pix ou boleto) até ${venc} pelo link: ${link} — Equipe Pontalti.`,
  [WHATSAPP_TEMPLATES.paymentConfirmed]: ([nome, num]) =>
    `Olá ${nome}! O pagamento do seu pedido ${num} foi confirmado. 🎉 Já estamos preparando tudo — você receberá atualizações por aqui.`,
  [WHATSAPP_TEMPLATES.orderUpdated]: ([nome, num, status]) =>
    `Olá ${nome}! Atualização do seu pedido ${num}: ele está ${status}.`,
};

async function sendViaEvolution(to: string, templateName: string, bodyParams: string[]): Promise<NotifyOutcome> {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!url || !key || !instance) {
    return { status: "skipped", error: "EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE não configurados" };
  }
  const text = TEMPLATE_TEXTS[templateName]?.(bodyParams) ?? bodyParams.join(" ");
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/message/sendText/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ number: to, text }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const json = (await resp.json().catch(() => null)) as { response?: { message?: unknown }; message?: unknown } | null;
    if (!resp.ok) {
      return { status: "failed", error: `Evolution respondeu HTTP ${resp.status}: ${JSON.stringify(json)?.slice(0, 300)}` };
    }
    return { status: "sent" };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Normaliza o telefone salvo em `customers.phone` (10–11 dígitos, sem DDI —
 * ver lib/validation.ts) para o formato E.164 sem "+" que a Cloud API espera.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return digits;
  return null;
}

export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  bodyParams: string[]
): Promise<NotifyOutcome> {
  if (provider() === "evolution") return sendViaEvolution(to, templateName, bodyParams);
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { status: "skipped", error: "WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID não configurados" };
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: TEMPLATE_LANGUAGE },
          ...(bodyParams.length > 0
            ? {
                components: [
                  {
                    type: "body",
                    parameters: bodyParams.map((text) => ({ type: "text", text })),
                  },
                ],
              }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const json = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!resp.ok) {
      return { status: "failed", error: json?.error?.message ?? `Cloud API respondeu HTTP ${resp.status}` };
    }
    return { status: "sent" };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
