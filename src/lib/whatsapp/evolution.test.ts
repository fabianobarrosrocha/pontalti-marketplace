import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvolution, sendEvolution } from "./evolution";
import { matchesSecret } from "./security";
import { safeAuthRedirect } from "@/lib/auth-redirect";

const payload = (
  key: Record<string, unknown> = {},
  message: Record<string, unknown> = { conversation: "produtos" }
) => ({
  instance: "test",
  event: "messages.upsert",
  data: { key: { fromMe: false, remoteJid: "5511999990000@s.whatsapp.net", id: "abc", ...key }, message }
});
test("normaliza texto e escolhas da instância autorizada", () => {
  assert.equal(normalizeEvolution(payload(), "test")[0].text, "produtos");
  assert.equal(
    normalizeEvolution(payload({}, { buttonsResponseMessage: { selectedButtonId: "v2:cart" } }), "test")[0].text,
    "v2:cart"
  );
  assert.throws(() => normalizeEvolution(payload(), "another"), /INSTANCE_MISMATCH/);
});
test("clique de cartão preserva o ID da ação, sem executar o texto exibido ou o índice", () => {
  const message = { templateButtonReplyMessage: {
    selectedId: "v12:select:product",
    selectedDisplayText: "Escolher produto",
    selectedIndex: 0,
    contextInfo: { stanzaId: "catalog-message" }
  } };
  assert.equal(normalizeEvolution(payload({}, message), "test")[0]?.text, "v12:select:product");
  assert.equal(normalizeEvolution(payload({}, { ephemeralMessage: { message } }), "test")[0]?.text, "v12:select:product");
  assert.deepEqual(normalizeEvolution(payload({}, { templateButtonReplyMessage: { selectedDisplayText: "Escolher produto", selectedIndex: 0 } }), "test"), []);
});
test("ignora eco, grupos, LID sem identidade telefônica e histórico antigo", () => {
  for (const key of [{ fromMe: true }, { remoteJid: "123@g.us" }, { remoteJid: "123@lid" }])
    assert.deepEqual(normalizeEvolution(payload(key), "test"), []);
  const old = payload();
  Object.assign(old.data, { messageTimestamp: Math.floor(Date.now() / 1000) - 90000 });
  assert.deepEqual(normalizeEvolution(old, "test"), []);
  assert.equal(
    normalizeEvolution(payload({ remoteJid: "123@lid", remoteJidAlt: "5511999990000@s.whatsapp.net" }), "test")[0].waId,
    "5511999990000"
  );
});
test("segredo precisa ser configurado e igual; redirecionamentos permanecem na loja", () => {
  const secret = "a".repeat(40);
  assert.equal(matchesSecret(secret, secret), true);
  assert.equal(matchesSecret("wrong", secret), false);
  assert.equal(matchesSecret("short", "short"), false);
  for (const url of ["//example.com", "/\\example.com", "https://example.com", "/\n/elsewhere"])
    assert.equal(safeAuthRedirect(url), "/conta");
  assert.equal(safeAuthRedirect("/conta/whatsapp/vincular/token"), "/conta/whatsapp/vincular/token");
});
test("nenhum envio é feito com transporte desabilitado", async () => {
  delete process.env.WHATSAPP_BOT_SEND_MODE;
  assert.equal((await sendEvolution("test", "5511999990000", { type: "text", text: "test" })).error, "SEND_DISABLED");
});
test("transporte mantém Pix literal e envia PNG em base64 sem hospedar o código de pagamento", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  Object.assign(process.env, { WHATSAPP_BOT_SEND_MODE: "live", EVOLUTION_INSTANCE: "test",
    EVOLUTION_API_URL: "http://127.0.0.1:59999", EVOLUTION_API_KEY: "dummy-test" });
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ key: { id: "accepted-pix" } });
    };
    const pix = "000201-PIX-CORA-COPIA-E-COLA";
    await sendEvolution("test", "5511999990000", { type: "text", text: pix, literal: true });
    assert.match(requests[0].url, /sendText\/test$/);
    assert.equal(requests[0].body.text, pix);
    assert.equal(requests[0].body.linkPreview, false);
    const png = "iVBORw0KGgo=";
    const result = await sendEvolution("test", "5511999990000", {
      type: "image", url: "data:image/png;base64," + png, caption: "QR Code Pix"
    });
    assert.equal(result.status, "accepted");
    assert.match(requests[1].url, /sendMedia\/test$/);
    assert.equal(requests[1].body.media, png);
    assert.equal(requests[1].body.mediatype, "image");
    assert.equal(requests[1].body.mimetype, "image/png");
    assert.equal(requests[1].body.caption, "QR Code Pix");
    await sendEvolution("test", "5511999990000", {
      type: "choices", text: "Produto real", imageUrl: "data:image/png;base64," + png,
      options: [{ id: "v7:select:real-product", label: "1. Produto real" }]
    });
    assert.match(requests[2].url, /sendButtons\/test$/);
    assert.equal(requests[2].body.thumbnailUrl, png);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
test("transporte envia botões, listas, um carrossel e PDF; mantém resultados incertos sem reenvio", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.WHATSAPP_BOT_SEND_MODE = "live";
  process.env.EVOLUTION_INSTANCE = "test";
  process.env.EVOLUTION_API_URL = "http://127.0.0.1:59999";
  process.env.EVOLUTION_API_KEY = "dummy-test";
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ key: { id: "accepted-id" } });
    };
    const outcome = await sendEvolution("test", "5511999990000", {
      type: "choices",
      text: "Escolha",
      options: [{ id: "v1:cart", label: "Carrinho" }]
    });
    assert.equal(outcome.status, "accepted");
    assert.match(requests[0].url, /sendButtons\/test$/);
    assert.deepEqual(requests[0].body.buttons, [{ type: "reply", displayText: "Carrinho", id: "v1:cart" }]);
    await sendEvolution("test", "5511999990000", {
      type: "image",
      url: "https://test.invalid/photo.png",
      caption: "Bojo"
    });
    assert.match(requests[1].url, /sendMedia\/test$/);
    assert.equal(requests[1].body.media, "https://test.invalid/photo.png");
    await sendEvolution("test", "5511999990000", {
      type: "carousel", text: "Catálogo", cards: [{
        productId: "product", title: "Bojo", text: "Bojo\nR$ 10,00 / unidade", imageUrl: "https://test.invalid/photo.png",
        options: [{ id: "v2:select:product", label: "Escolher produto" }]
      }]
    });
    assert.match(requests[2].url, /sendCarousel\/test$/);
    assert.deepEqual(requests[2].body.cards, [{
      title: "Bojo", body: "Bojo\nR$ 10,00 / unidade", imageUrl: "https://test.invalid/photo.png",
      buttons: [{ type: "reply", displayText: "Escolher produto", id: "v2:select:product" }]
    }]);
    await sendEvolution("test", "5511999990000", {
      type: "choices", text: "Carrinho", options: Array.from({ length: 4 }, (_, i) => ({ id: "v3:edit:" + i, label: "Item " + i }))
    });
    assert.match(requests[3].url, /sendList\/test$/);
    const sections = requests[3].body.sections as { rows: { rowId: string }[] }[];
    assert.equal(sections[0].rows[3].rowId, "v3:edit:3");
    await sendEvolution("test", "5511999990000", {
      type: "document", url: "https://test.invalid/boleto.pdf", filename: "boleto-pontalti.pdf", caption: "Boleto Cora"
    });
    assert.equal(requests[4].body.mediatype, "document");
    assert.equal(requests[4].body.fileName, "boleto-pontalti.pdf");
    await sendEvolution("test", "5511999990000", {
      type: "choices", text: "Catálogo", imageUrl: "https://test.invalid/catalog.png", options: [{id:"v12:select:product",label:"Bojo clássico"}]
    });
    assert.match(requests[5].url, /sendButtons\/test$/);
    assert.equal(requests[5].body.thumbnailUrl, "https://test.invalid/catalog.png");
    const invalid = await sendEvolution("test", "5511999990000", {
      type: "choices", text: "Catálogo", imageUrl: "https://test.invalid/catalog.png", options: Array.from({length:4},(_,i)=>({id:"v12:select:"+i,label:"Bojo "+i}))
    });
    assert.equal(invalid.error, "INTERACTIVE_IMAGE_OPTIONS_INVALID");
    assert.equal(requests.length, 6);
    globalThis.fetch = async () => {
      throw new Error("TIMEOUT");
    };
    assert.equal((await sendEvolution("test", "5511999990000", { type: "text", text: "teste" })).status, "unknown");
    assert.equal((await sendEvolution("other", "5511999990000", { type: "text", text: "teste" })).status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
