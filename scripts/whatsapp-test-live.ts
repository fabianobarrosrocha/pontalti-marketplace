import { loadEnvConfig } from "@next/env";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { cpf } from "cpf-cnpj-validator";
import { localDatabase, localToken, TEST_API_URL, TEST_DATABASE_URL } from "../tests/support/database";
import { testChannelMessages, testMessagePresentation } from "./support/whatsapp-live-channel";
import { SupabaseTestCatalog } from "./support/supabase-test-catalog";
import { disableCoreFinanceForLocalFixtures } from "./support/local-finance-isolation";
import type { BotMessage } from "../src/lib/whatsapp/types";

const PORT = 3015;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LOCAL_TOKEN_LIFETIME = 24 * 60 * 60;
const CUSTOMER = "10000000-0000-4000-8000-000000000003";
const CUSTOMER_PROFILE = { full_name: "Cliente WhatsApp de homologação", cpf: "93541134780" };
const ADDRESS = "20000000-0000-4000-8000-000000000003";

async function main() {
  loadEnvConfig(process.cwd());
  disableCoreFinanceForLocalFixtures();
  if (process.env.CORA_ENV !== "stage") throw new Error("Esta conversa exige CORA_ENV=stage.");
  if (!CUSTOMER_PROFILE.full_name.trim() || !cpf.isValid(CUSTOMER_PROFILE.cpf))
    throw new Error("O cadastro fictício precisa estar completo para testar a compra.");
  const account = process.env.WHATSAPP_TEST_INSTANCE ?? "";
  const botNumber = process.env.WHATSAPP_TEST_BOT_NUMBER ?? "";
  const customerNumber = process.env.WHATSAPP_TEST_CUSTOMER_NUMBER ?? "";
  const selfChat = process.argv.includes("--self-chat");
  const resume = process.argv.includes("--resume");
  if (!account || !botNumber || !customerNumber || !/^\d{10,15}$/.test(customerNumber))
    throw new Error("Configure a instância conectada e os números de bot/cliente de teste.");
  if (selfChat !== (botNumber === customerNumber))
    throw new Error("Use --self-chat somente quando bot e cliente forem o mesmo número.");
  const providerUrl = process.env.EVOLUTION_API_URL?.replace(/\/$/, "") ?? "";
  const apiKey = process.env.EVOLUTION_API_KEY ?? "";
  if (!providerUrl || !apiKey) throw new Error("Evolution não configurada.");
  // Capture the store configuration before routing private test data to the local database.
  const sourceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  const sourceKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sourceUrl || !sourceKey) throw new Error("Configure o catálogo público do Supabase da loja.");
  const source = createClient(sourceUrl, sourceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }) }
  });
  const webhookSecret = randomBytes(32).toString("hex");
  const webhookUrl = `http://host.docker.internal:${PORT}/api/webhooks/whatsapp/evolution`;
  process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_API_URL;
  // Long-running phone tests must not stop accepting messages after one hour.
  process.env.SUPABASE_SERVICE_ROLE_KEY = localToken("service_role", undefined, LOCAL_TOKEN_LIFETIME);
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  process.env.WHATSAPP_BOT_ENABLED = "true";
  process.env.WHATSAPP_BOT_SEND_MODE = "live";
  process.env.WHATSAPP_PROVIDER = "evolution";
  process.env.EVOLUTION_INSTANCE = account;
  process.env.WHATSAPP_WEBHOOK_SECRET = webhookSecret;
  process.env.WHATSAPP_LINK_SECRET = randomBytes(32).toString("hex");

  const db = localDatabase("service_role", undefined, LOCAL_TOKEN_LIFETIME);
  const { createInvoice, getInvoice } = await import("../src/lib/cora/client");
  const { SupabaseBotServices } = await import("../src/lib/whatsapp/repository");
  const { workerTick } = await import("../src/lib/whatsapp/worker");
  const { sendEvolution } = await import("../src/lib/whatsapp/evolution");
  const { catalogSender } = await import("../src/lib/whatsapp/catalog-presentation");
  const { matchesSecret } = await import("../src/lib/whatsapp/security");
  const { POST: receiveWebhook } = await import("../src/app/api/webhooks/whatsapp/evolution/route");
  const services = new SupabaseBotServices(db, { createInvoice, getInvoice });
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
  const catalog = new SupabaseTestCatalog(source, pool, sourceUrl);
  services.catalog = (query, page) => catalog.catalog(query, page);
  services.products = (ids) => catalog.products(ids);
  const mutateCart = services.mutateCart.bind(services);
  services.mutateCart = async (customerId, items, mode, operationId) => {
    if (mode !== "clear") await services.products(items.map((item) => item.productId));
    return mutateCart(customerId, items, mode, operationId);
  };
  const checkout = services.checkout.bind(services);
  services.checkout = async (customerId, preview, conversationId) => {
    await services.cart(customerId); // Refresh price and availability before the local checkout transaction.
    return checkout(customerId, preview, conversationId);
  };
  const repeatOrder = services.repeatOrder.bind(services);
  services.repeatOrder = async (customerId, contactId, orderId, lines, operationId) => {
    await services.products(lines.map((line) => line.productId));
    return repeatOrder(customerId, contactId, orderId, lines, operationId);
  };
  const outboundLiteralTexts = new Set<string>();
  const sendCatalog = catalogSender(sourceUrl, async (instance, number, presented) => {
    if (presented.type === "text" && presented.literal) outboundLiteralTexts.add(presented.text);
    return sendEvolution(instance, number, testMessagePresentation(presented));
  });
  const deps = {
    db,
    services,
    account,
    invoiceCreate: createInvoice,
    invoiceGet: getInvoice,
    send: async (instance: string, number: string, message: BotMessage) => {
      if (instance !== account || number !== customerNumber)
        return { status: "failed" as const, error: "TEST_DESTINATION_NOT_ALLOWED" };
      return sendCatalog(instance, number, message);
    },
    notify: async () => {}
  };
  const checked = (error: unknown) => {
    if (error) throw new Error("Operação no banco local de homologação falhou.");
  };
  async function provider(path: string, body?: unknown) {
    const response = await fetch(providerUrl + path, {
      method: body ? "POST" : "GET",
      headers: { apikey: apiKey!, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("EVOLUTION_HTTP_" + response.status);
    return response.json();
  }
  const connection = await provider("/instance/connectionState/" + encodeURIComponent(account));
  if (connection.instance?.state !== "open") throw new Error("A instância de teste não está conectada.");

  // A URL fixa e a verificação do nome impedem gravar no Supabase real.
  const pg = new Client({ connectionString: TEST_DATABASE_URL });
  await pg.connect();
  try {
    const info = await pg.query("select current_database() as name");
    if (info.rows[0].name !== "pontalti_whatsapp_test") throw new Error("TEST_DATABASE_REQUIRED");
    await pg.query("begin");
    await pg.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,null,$2) on conflict(id) do nothing",
      [CUSTOMER, CUSTOMER_PROFILE]
    );
    const storedProfile = (await pg.query("select full_name,cpf from public.customers where id=$1", [CUSTOMER])).rows[0];
    if (!resume || !storedProfile?.full_name?.trim() || !cpf.isValid(storedProfile?.cpf ?? ""))
      await pg.query(
        "update public.customers set full_name=$2,cpf=$3 where id=$1",
        [CUSTOMER, CUSTOMER_PROFILE.full_name, CUSTOMER_PROFILE.cpf]
      );
    await pg.query(
      "insert into public.customer_addresses(id,customer_id,zip_code,street,number,neighborhood,city,state,is_default) values($1,$2,'01001000','Rua de homologação','1','Teste','São Paulo','SP',true) on conflict(id) do nothing",
      [ADDRESS, CUSTOMER]
    );
    // Preserve historical orders while retiring the previous fixture catalog.
    await pg.query("update public.product_marketplace_config set is_visible=false");
    await pg.query("update public.whatsapp_settings set value=$1 where key='delivery'", [
      { enabled: true, description: "Retirada de homologação", feeCents: 0, states: ["SP"] }
    ]);
    await pg.query("update public.whatsapp_settings set value='\"unidade de teste\"'::jsonb where key='unit_label'");
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  } finally {
    await pg.end();
  }
  if (!(await services.profileComplete(CUSTOMER)))
    throw new Error("O cadastro fictício não está pronto para finalizar a compra.");
  const initialCatalog = await services.catalog("", 0);

  const startedAt = Date.now();
  let received = 0;
  let stopped = false;
  let busy = false;
  let workerErrors = 0;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      await workerTick(deps);
    } catch {
      workerErrors++;
      console.error("Worker de homologação aguardando recuperação.");
    } finally {
      busy = false;
    }
  }
  async function ingest(payload: unknown) {
    const messages = testChannelMessages(payload, { account, customerNumber, selfChat, startedAt, outboundLiteralTexts });
    for (const message of messages) {
      const response = await receiveWebhook(new Request(ORIGIN + "/api/webhooks/whatsapp/evolution", {
        method: "POST",
        headers: { "content-type": "application/json", "x-whatsapp-webhook-secret": webhookSecret },
        body: JSON.stringify({
          event: "messages.upsert", instance: account,
          data: {
            key: { id: message.externalId, remoteJid: customerNumber + "@s.whatsapp.net", fromMe: false },
            messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: message.text }
          }
        })
      }));
      if (!response.ok) throw new Error("WEBHOOK_PERSISTENCE_FAILED");
      received++;
      console.log(JSON.stringify({ event: "test_whatsapp_message", id: message.externalId, received }));
    }
    return messages.length;
  }
  async function snapshot() {
    const contact = await db.from("whatsapp_contacts").select("id").eq("account", account).eq("wa_id", customerNumber).single();
    checked(contact.error);
    const conversation = await db.from("whatsapp_conversations").select("id,state,version").eq("contact_id", contact.data!.id).single();
    checked(conversation.error);
    const outbox = await db.from("whatsapp_outbox").select("status,error,provider_message_id").eq("conversation_id", conversation.data!.id);
    checked(outbox.error);
    return {
      environment: "Catálogo Supabase real · compras locais · Cora stage · WhatsApp real", selfChat, received, workerErrors,
      catalogSource: "supabase-store-read-only",
      conversation: conversation.data, cart: await services.cart(CUSTOMER), orders: await services.orders(CUSTOMER),
      outbox: outbox.data
    };
  }
  async function readBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 256 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  function json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", ORIGIN).pathname;
    try {
      if (request.method === "GET" && path === "/health") return json(response, { ready: true, stage: true });
      if (request.method === "POST" && path === "/api/webhooks/whatsapp/evolution") {
        if (!matchesSecret(String(request.headers["x-whatsapp-webhook-secret"] ?? ""), webhookSecret))
          return json(response, { error: "UNAUTHORIZED" }, 401);
        return json(response, { accepted: await ingest(await readBody(request)) });
      }
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
      const localHost = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(request.headers.host ?? "");
      if (!local || !localHost) return json(response, { error: "LOCAL_ONLY" }, 403);
      if (request.method === "GET" && path === "/api/state") return json(response, await snapshot());
      if (request.method === "POST" && path === "/api/test-input") {
        if (request.headers.origin) return json(response, { error: "LOCAL_SCRIPT_ONLY" }, 403);
        const input = await readBody(request);
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000)
          return json(response, { error: "INVALID_TEXT" }, 400);
        const count = await ingest({
          event: "messages.upsert", instance: account,
          data: { key: { id: "script-" + randomUUID(), remoteJid: customerNumber + "@s.whatsapp.net", fromMe: selfChat },
            messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: input.text } }
        });
        return json(response, { accepted: count, source: "local_script_not_phone" });
      }
      return json(response, { error: "NOT_FOUND" }, 404);
    } catch {
      return json(response, { error: "TEST_REQUEST_FAILED" }, 503);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "0.0.0.0", resolve);
  });
  try {
    // Somente a conta fictícia é pré-vinculada para a compra de homologação.
    if (!resume) {
      const intro = await db.rpc("whatsapp_receive", {
        p_account: account, p_wa_id: customerNumber, p_external_id: "bootstrap-" + randomUUID(), p_text: "produtos"
      });
      checked(intro.error);
    } else {
      const existing = await db.from("whatsapp_contacts").select("id").eq("account", account).eq("wa_id", customerNumber).single();
      checked(existing.error);
    }
    const linked = await db.from("whatsapp_contacts").update({ customer_id: CUSTOMER }).eq("account", account).eq("wa_id", customerNumber);
    checked(linked.error);
    await provider("/webhook/set/" + encodeURIComponent(account), { webhook: {
      enabled: true, url: webhookUrl, headers: { "x-whatsapp-webhook-secret": webhookSecret },
      byEvents: false, base64: false, events: ["MESSAGES_UPSERT"]
    } });
    await tick();
  } catch (error) {
    server.close();
    await pool.end();
    throw error;
  }
  const timer = setInterval(() => { void tick(); }, 1000);
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await provider("/webhook/set/" + encodeURIComponent(account), { webhook: { enabled: false, url: webhookUrl, events: [] } }).catch(() => {});
    server.close();
    await pool.end();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  console.log(JSON.stringify({ ready: true, port: PORT, selfChat, scope: "local_stage_with_real_whatsapp", catalogSource: "supabase-store-read-only", products: initialCatalog.products.length }));
  console.log("Envie menu no WhatsApp de teste. Nenhum comprador, pedido ou configuração do Supabase real foi alterado.");
}

main().catch(error => {
  console.error("Conversa ao vivo não iniciou:", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
