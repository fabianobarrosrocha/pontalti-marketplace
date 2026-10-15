#!/usr/bin/env node
// Simula o pagamento de uma cobrança no STAGE da Cora (POST /v2/invoices/pay).
// Uso (na pasta marketplace-frontend):
//   node scripts/simulate-payment.mjs            → paga a cobrança "open" mais recente
//   node scripts/simulate-payment.mjs <order_id> → paga a cobrança daquele pedido
// Depois é só olhar a tela de pagamento (polling de 6s) ou o webhook fazer o resto.

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// .env.local simples (KEY=VALUE, sem interpolação)
const env = {};
for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
}

const need = (k) => {
  if (!env[k]) {
    console.error(`Falta ${k} no .env.local`);
    process.exit(1);
  }
  return env[k];
};

if ((env.CORA_ENV ?? "stage") !== "stage") {
  console.error("CORA_ENV não é 'stage' — este script só roda contra o ambiente de teste.");
  process.exit(1);
}

const SUPABASE_URL = need("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");
const CLIENT_ID = need("CORA_CLIENT_ID");
const cert = env.CORA_CERT_PEM ?? readFileSync(need("CORA_CERT_PATH"), "utf8");
const key = env.CORA_KEY_PEM ?? readFileSync(need("CORA_KEY_PATH"), "utf8");
const HOST = "matls-clients.api.stage.cora.com.br";

function mtls({ method, path, headers, body }) {
  return new Promise((res, rej) => {
    const req = httpsRequest({ host: HOST, method, path, cert, key, headers, timeout: 25_000 }, (r) => {
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = { raw: data.slice(0, 300) }; }
        res({ status: r.statusCode ?? 0, json });
      });
    });
    req.on("error", rej);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

// 1. Acha a cobrança no Supabase. Aceita o UUID completo ou o prefixo curto
// (#xxxxxxxx) que aparece nas notificações — nesse caso filtra em JS.
const orderIdArg = (process.argv[2] ?? "").replace(/^#/, "");
const isFullUuid = /^[0-9a-f-]{36}$/i.test(orderIdArg);
const filter = isFullUuid
  ? `order_id=eq.${orderIdArg}`
  : orderIdArg
    ? "" // prefixo curto: busca as últimas e filtra em JS
    : "status=eq.open";
const limit = orderIdArg && !isFullUuid ? 50 : 1;
const restUrl =
  `${SUPABASE_URL}/rest/v1/order_payments` +
  `?select=cora_invoice_id,order_id,status,amount${filter ? `&${filter}` : ""}` +
  `&order=created_at.desc&limit=${limit}`;
const restResp = await fetch(restUrl, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
});
const rows = await restResp.json();
const candidates = Array.isArray(rows) ? rows : [];
const payment = orderIdArg
  ? candidates.find((r) => r.order_id.startsWith(orderIdArg.toLowerCase()))
  : candidates.find((r) => r.status === "open");
if (!restResp.ok || !payment) {
  console.error(orderIdArg
    ? `Nenhuma cobrança encontrada para o pedido ${orderIdArg}.`
    : "Nenhuma cobrança com status 'open' encontrada — faça uma compra na loja primeiro.");
  process.exit(1);
}
console.log(`Cobrança: ${payment.cora_invoice_id}`);
console.log(`Pedido:   #${payment.order_id.slice(0, 8)} (${payment.order_id})`);
console.log(`Valor:    R$ ${Number(payment.amount).toFixed(2)} — status atual: ${payment.status}`);

// 2. Token mTLS
const tokenBody = `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}`;
const tok = await mtls({
  method: "POST",
  path: "/token",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": String(Buffer.byteLength(tokenBody)),
  },
  body: tokenBody,
});
if (tok.status !== 200 || !tok.json?.access_token) {
  console.error(`Falha ao autenticar na Cora (HTTP ${tok.status}):`, tok.json);
  process.exit(1);
}

// 3. Simula o pagamento
const payBody = JSON.stringify({ id: payment.cora_invoice_id });
const pay = await mtls({
  method: "POST",
  path: "/v2/invoices/pay",
  headers: {
    Authorization: `Bearer ${tok.json.access_token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
    "Content-Length": String(Buffer.byteLength(payBody)),
  },
  body: payBody,
});
if (pay.status < 200 || pay.status >= 300) {
  console.error(`Cora respondeu HTTP ${pay.status}:`, JSON.stringify(pay.json, null, 2));
  process.exit(1);
}
console.log("\n✅ Pagamento simulado no stage.");
console.log("A tela de pagamento (polling de 6s) deve confirmar em instantes,");
console.log("e a notificação 💰 deve cair no Telegram.");
