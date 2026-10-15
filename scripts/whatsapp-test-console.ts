import { loadEnvConfig } from "@next/env";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { disableCoreFinanceForLocalFixtures } from "./support/local-finance-isolation";
import {
  localDatabase,
  localToken,
  seedTestDatabase,
  CUSTOMER_A,
  PRODUCT_A,
  TEST_API_URL
} from "../tests/support/database";

// Ferramenta de desenvolvimento: transporte interceptado e banco local fixo.
// Não importar notificações legadas nem iniciar o worker de produção aqui.
const PORT = 3013;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "local-test-console";
const WA_ID = "5511999990000";

async function main() {
  loadEnvConfig(process.cwd());
  disableCoreFinanceForLocalFixtures();
  if (process.env.CORA_ENV !== "stage") throw new Error("A conversa de teste exige CORA_ENV=stage.");
  process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_API_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = localToken();
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  process.env.WHATSAPP_BOT_ENABLED = "true";
  process.env.WHATSAPP_BOT_SEND_MODE = "disabled";
  process.env.EVOLUTION_INSTANCE = ACCOUNT;
  process.env.WHATSAPP_WEBHOOK_SECRET = randomUUID();
  process.env.WHATSAPP_LINK_SECRET = randomUUID();

  const db = localDatabase();
  const { createInvoice, getInvoice, simulatePaymentInStage } = await import("../src/lib/cora/client");
  const { syncInvoiceStatus } = await import("../src/lib/cora/payment-sync");
  const { SupabaseBotServices } = await import("../src/lib/whatsapp/repository");
  const { workerTick } = await import("../src/lib/whatsapp/worker");
  const { hashToken, hashChallenge } = await import("../src/lib/whatsapp/security");
  const { POST: receiveWebhook } = await import("../src/app/api/webhooks/whatsapp/evolution/route");
  const services = new SupabaseBotServices(db, { createInvoice, getInvoice });
  const deps = {
    db,
    services,
    account: ACCOUNT,
    invoiceCreate: createInvoice,
    invoiceGet: getInvoice,
    send: async () => ({
      status: "accepted" as const,
      providerMessageId: "local-" + randomUUID()
    }),
    notify: async () => {}
  };
  const html = await readFile("scripts/whatsapp-test-console.html", "utf8");
  const check = (error: unknown) => {
    if (error) throw new Error("Não foi possível concluir a operação no banco de teste.");
  };

  async function send(text: string) {
    const response = await receiveWebhook(
      new Request(ORIGIN + "/api/webhooks/whatsapp/evolution", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-whatsapp-webhook-secret": process.env.WHATSAPP_WEBHOOK_SECRET!
        },
        body: JSON.stringify({
          event: "messages.upsert",
          instance: ACCOUNT,
          data: {
            key: {
              id: randomUUID(),
              remoteJid: WA_ID + "@s.whatsapp.net",
              fromMe: false
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: { conversation: text }
          }
        })
      })
    );
    if (!response.ok) throw new Error("O webhook não aceitou a mensagem de teste.");
    await workerTick(deps);
    const errors = await db.from("whatsapp_inbox_events").select("id").neq("status", "done");
    check(errors.error);
    if (errors.data?.length) throw new Error("A mensagem ficou pendente. Consulte a fila de teste.");
  }
  async function reset() {
    await seedTestDatabase();
    const product = await db
      .from("product_marketplace_config")
      .update({
        display_price: 5,
        display_title: "Bojo · produto de teste",
        display_description: "Item fictício para homologar a compra. R$ 5,00 por unidade de teste."
      })
      .eq("id", PRODUCT_A);
    check(product.error);
    await send("oi");
  }
  async function snapshot() {
    const messages = await db
      .from("whatsapp_messages")
      .select("id,direction,content,created_at")
      .order("created_at")
      .order("id");
    check(messages.error);
    const contact = await db.from("whatsapp_contacts").select("customer_id").eq("account", ACCOUNT).single();
    check(contact.error);
    const orders = await db
      .from("orders")
      .select("id,status,total,order_payments(status,cora_invoice_id)")
      .eq("customer_id", CUSTOMER_A)
      .order("created_at", { ascending: false });
    check(orders.error);
    return {
      messages: messages.data,
      linked: contact.data?.customer_id === CUSTOMER_A,
      cart: await services.cart(CUSTOMER_A),
      orders: orders.data,
      environment: "Cora staging · banco local · mensagens simuladas"
    };
  }
  async function claimLink(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Link de teste inválido.");
    const tokenHash = hashToken(token);
    const code = String(randomInt(100000, 1000000));
    const result = await db.rpc("whatsapp_claim_link", {
      p_token_hash: tokenHash,
      p_customer_id: CUSTOMER_A,
      p_challenge_hash: hashChallenge(tokenHash, code)
    });
    check(result.error);
    if (!result.data) throw new Error("Este link expirou ou já foi utilizado.");
    return { code };
  }
  async function pay(orderId: string) {
    const result = await db
      .from("orders")
      .select("id,status,order_payments(cora_invoice_id)")
      .eq("id", orderId)
      .eq("customer_id", CUSTOMER_A)
      .single();
    check(result.error);
    const invoiceId = result.data?.order_payments?.[0]?.cora_invoice_id;
    if (!invoiceId) throw new Error("O pedido ainda não tem cobrança emitida.");
    if (result.data?.status !== "paid") await simulatePaymentInStage(invoiceId);
    for (let i = 0; i < 12; i++) {
      const sync = await syncInvoiceStatus(invoiceId, db, getInvoice);
      if (sync?.paymentStatus === "paid") {
        await workerTick(deps);
        return;
      }
      await setTimeout(1000);
    }
    throw new Error("A Cora ainda está processando. Consulte o pagamento novamente.");
  }

  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let text = "";
    for await (const chunk of request) {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 16_384) throw new Error("Mensagem muito longa.");
    }
    const value: unknown = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Requisição inválida.");
    return value as Record<string, unknown>;
  }
  function json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify(value));
  }

  // Serializa interações e resets. A interface não compartilha dados com a loja real.
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    const host = request.headers.host;
    const allowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!allowed.includes(host ?? "")) return json(response, { error: "Host inválido." }, 403);
    const origin = request.headers.origin;
    if (origin && ![ORIGIN, `http://localhost:${PORT}`].includes(origin))
      return json(response, { error: "Origem inválida." }, 403);
    const path = new URL(request.url ?? "/", ORIGIN).pathname;
    if (request.method === "GET" && !path.startsWith("/api/")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer"
      });
      return response.end(html);
    }
    queue = queue.then(async () => {
      try {
        if (request.method === "GET" && path === "/api/state") return json(response, await snapshot());
        if (request.method !== "POST" || !request.headers["content-type"]?.startsWith("application/json"))
          return json(response, { error: "Requisição inválida." }, 400);
        const input = await body(request);
        if (path === "/api/send") {
          if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000)
            throw new Error("Digite uma mensagem de até 2000 caracteres.");
          await send(input.text.trim());
        } else if (path === "/api/reset") await reset();
        else if (path === "/api/link" && typeof input.token === "string")
          return json(response, await claimLink(input.token));
        else if (path === "/api/pay" && typeof input.orderId === "string") await pay(input.orderId);
        else return json(response, { error: "Rota não encontrada." }, 404);
        json(response, await snapshot());
      } catch (error) {
        json(
          response,
          {
            error: error instanceof Error ? error.message : "Falha na conversa de teste."
          },
          400
        );
      }
    });
  });
  // Não limpar a base se a porta já estiver ocupada por outra sessão de teste.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  try {
    await reset();
  } catch (error) {
    server.close();
    throw error;
  }
  console.log(`Conversa de teste pronta: ${ORIGIN}`);
  console.log("Cora stage real; Postgres local; transporte WhatsApp/Telegram interceptado.");
}

main().catch((error) => {
  console.error(
    "Não foi possível iniciar a conversa de teste:",
    error instanceof Error ? error.message : "UNKNOWN_ERROR"
  );
  process.exitCode = 1;
});
