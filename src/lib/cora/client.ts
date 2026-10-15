import "server-only";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";

// Client da Integração Direta do Banco Cora (mTLS).
// Envs (server-only): CORA_ENV (stage|production), CORA_CLIENT_ID e
// CORA_CERT_PATH/CORA_KEY_PATH (caminhos) OU CORA_CERT_PEM/CORA_KEY_PEM (conteúdo).

const HOSTS = {
  stage: "matls-clients.api.stage.cora.com.br",
  production: "matls-clients.api.cora.com.br"
} as const;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function loadCredentials() {
  const clientId = env("CORA_CLIENT_ID");
  if (!clientId) throw new Error("CORA_CLIENT_ID não configurado no .env.local.");
  const cert =
    env("CORA_CERT_PEM") ?? (env("CORA_CERT_PATH") ? readFileSync(env("CORA_CERT_PATH")!, "utf8") : undefined);
  const key = env("CORA_KEY_PEM") ?? (env("CORA_KEY_PATH") ? readFileSync(env("CORA_KEY_PATH")!, "utf8") : undefined);
  if (!cert || !key) {
    throw new Error("Certificado/chave da Cora não configurados (CORA_CERT_PATH/CORA_KEY_PATH ou *_PEM).");
  }
  const host = HOSTS[(env("CORA_ENV") as keyof typeof HOSTS) ?? "stage"] ?? HOSTS.stage;
  return { clientId, cert, key, host };
}

function mtlsRequest(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; json: unknown }> {
  const { cert, key, host } = loadCredentials();
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host,
        method: options.method,
        path: options.path,
        cert,
        key,
        headers: options.headers,
        timeout: 25_000
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data.slice(0, 500) };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout na chamada à Cora.")));
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Token cacheado no módulo (expira em 1h no stage; renova com 60s de folga).
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const { clientId } = loadCredentials();
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}`;
  const { status, json } = await mtlsRequest({
    method: "POST",
    path: "/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body))
    },
    body
  });
  const data = json as { access_token?: string; expires_in?: number };
  if (status !== 200 || !data.access_token) {
    throw new Error(`Falha ao autenticar na Cora (HTTP ${status}).`);
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000
  };
  return cachedToken.token;
}

async function coraFetch(method: string, path: string, payload?: unknown, idempotencyKey?: string): Promise<unknown> {
  const token = await getAccessToken();
  const body = payload !== undefined ? JSON.stringify(payload) : undefined;
  const { status, json } = await mtlsRequest({
    method,
    path,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "Idempotency-Key": idempotencyKey ?? randomUUID() } : {}),
      ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {})
    },
    body
  });
  if (status < 200 || status >= 300) {
    const err = json as { message?: string; errors?: { code?: string; message?: string }[] };
    const detail = err?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? err?.message;
    throw new Error(`Cora respondeu ${status} em ${method} ${path}${detail ? ` — ${detail}` : ""}`);
  }
  return json;
}

// ─── API pública do módulo ───────────────────────────────────────

export type CoraInvoice = {
  id: string;
  status: "DRAFT" | "OPEN" | "IN_PAYMENT" | "PAID" | "LATE" | "CANCELLED" | string;
  total_amount: number; // centavos
  total_paid: number;
  code?: string;
  payment_options?: {
    bank_slip?: { url?: string; digitable?: string; barcode?: string } | null;
  } | null;
  pix?: { emv?: string | null } | null;
  payments?: unknown[];
};

export type CreateInvoiceInput = {
  code: string; // nossa referência (id do pedido)
  customerName: string;
  customerEmail: string | null;
  cpf: string;
  amountCents: number; // mínimo 500 (R$ 5,00)
  description: string;
  dueDate: string; // YYYY-MM-DD
};

export async function createInvoice(input: CreateInvoiceInput, idempotencyKey: string): Promise<CoraInvoice> {
  if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new Error("Chave de idempotência inválida.");
  const payload: Record<string, unknown> = {
    code: input.code,
    customer: {
      name: input.customerName,
      ...(input.customerEmail ? { email: input.customerEmail } : {}),
      document: { identity: input.cpf, type: "CPF" }
    },
    services: [{ name: input.description, amount: input.amountCents }],
    payment_terms: { due_date: input.dueDate },
    payment_forms: ["BANK_SLIP", "PIX"]
  };
  return (await coraFetch("POST", "/v2/invoices/", payload, idempotencyKey)) as CoraInvoice;
}

export async function getInvoice(invoiceId: string): Promise<CoraInvoice> {
  return (await coraFetch("GET", `/v2/invoices/${invoiceId}`)) as CoraInvoice;
}

export async function cancelInvoice(invoiceId: string): Promise<void> {
  await coraFetch("DELETE", `/v2/invoices/${invoiceId}`);
}

/** Cadastra o endpoint de webhook (invoice.paid) — usar uma vez por ambiente. */
export async function registerWebhookEndpoint(url: string, trigger = "paid"): Promise<unknown> {
  return coraFetch("POST", "/endpoints", { url, resource: "invoice", trigger });
}

/** Somente stage: simula o pagamento de um boleto. */
export async function simulatePaymentInStage(invoiceId: string): Promise<unknown> {
  if (process.env.CORA_ENV !== "stage") throw new Error("Simulação permitida somente em stage.");
  return coraFetch("POST", "/v2/invoices/pay", { id: invoiceId });
}
