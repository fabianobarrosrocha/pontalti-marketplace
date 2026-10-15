import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderCatalog, renderProduct, catalogSender } from "./catalog-presentation";
import type { BotMessage } from "./types";

const origin = "https://store.supabase.co";
const catalog = (count = 3): Extract<BotMessage, { type: "carousel" }> => ({
  type: "carousel", text: "Catálogo", customerId: "buyer",
  cards: Array.from({ length: count }, (_, index) => ({
    productId: String(index), title: "Produto real " + (index + 1), text: "Produto real " + (index + 1) + "\nSKU: REAL\nR$ 20,00 / unidade",
    imageUrl: `${origin}/storage/v1/object/public/product-images/${index}.png`,
    options: [{ id: "v7:select:" + index, label: "Escolher produto" }, { id: "v7:details:" + index, label: "Ver detalhes" }]
  }))
});
async function photo(color: string) {
  return sharp({ create: { width: 400, height: 280, channels: 3, background: color } }).png().toBuffer();
}
async function pixels(url: string) {
  return sharp(Buffer.from(url.split(",")[1], "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}
test("produto individual envia sua foto real e seus botões na mesma mensagem", async () => {
  const card = catalog(1).cards[0];
  const source = await photo("#00ff00");
  const result = await renderProduct({ type: "product", ...card, customerId: "buyer" }, origin,
    async () => new Response(new Uint8Array(source), { headers: { "content-type": "image/png" } }));
  if (result.type !== "choices") throw new Error("Expected image and reply buttons");
  assert.equal(result.customerId, "buyer");
  assert.equal(result.text, card.text);
  assert.deepEqual(result.options, card.options);
  const { data, info } = await pixels(result.imageUrl!);
  assert.deepEqual([info.width, info.height], [640, 480]);
  const center = (240 * info.width + 320) * info.channels;
  assert.deepEqual([...data.subarray(center, center + 3)], [0, 255, 0]);
});
test("sender prepara um produto sem foto como imagem e botões, preservando o resultado do transporte", async () => {
  const sent: BotMessage[] = [];
  const sender = catalogSender(origin, async (_account, _waId, message) => {
    sent.push(message);
    return { status: "unknown", error: "SEND_RESULT_UNKNOWN" };
  });
  const card = { ...catalog(1).cards[0], imageUrl: null };
  const outcome = await sender("test", "5511999990000", { type: "product", ...card });
  assert.deepEqual(outcome, { status: "unknown", error: "SEND_RESULT_UNKNOWN" });
  assert.equal(sent.length, 1);
  if (sent[0].type !== "choices") throw new Error("Expected image and reply buttons");
  assert.ok(sent[0].imageUrl);
  assert.deepEqual(sent[0].options, card.options);
});
test("carrossel mantém fotos separadas, ordem e ações próprias de cada produto", async () => {
  const photos = await Promise.all([photo("#ff0000"), photo("#00ff00"), photo("#0000ff")]);
  const urls: string[] = [];
  const request: typeof fetch = async (input, options) => {
    const url = String(input);
    urls.push(url);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    const index = Number(url.match(/(\d)\.png$/)![1]);
    return new Response(new Uint8Array(photos[index]), { headers: { "content-type": "image/png" } });
  };
  const page = catalog();
  const result = await renderCatalog(page, origin, request);
  if (result.type !== "carousel") throw new Error("Expected native carousel, without a collage");
  assert.equal(result.customerId, "buyer");
  assert.equal(result.cards.length, 3);
  assert.deepEqual(urls, page.cards.map((card) => card.imageUrl));
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(result.cards[index].options, page.cards[index].options);
    assert.equal(result.cards[index].productId, page.cards[index].productId);
    assert.equal(result.cards[index].text, page.cards[index].text);
    const { data, info } = await pixels(result.cards[index].imageUrl!);
    assert.deepEqual([info.width, info.height], [640, 480]);
    const offset = (240 * info.width + 320) * info.channels;
    assert.deepEqual([...data.subarray(offset, offset + 3)], [[255, 0, 0], [0, 255, 0], [0, 0, 255]][index]);
  }
  assert.deepEqual(page, catalog());
});
test("foto ausente ou externa recebe indicação no próprio cartão sem buscar hosts arbitrários", async () => {
  const page = catalog(2);
  page.cards[0].imageUrl = null;
  page.cards[1].imageUrl = "http://127.0.0.1/private";
  let requests = 0;
  const result = await renderCatalog(page, origin, async () => { requests++; throw new Error("UNEXPECTED_FETCH"); });
  assert.equal(requests, 0);
  if (result.type !== "carousel") throw new Error("Expected native carousel");
  assert.equal(result.cards.length, 2);
  assert.ok(result.cards.every((card) => card.imageUrl?.startsWith("data:image/png;base64,")));
  assert.notEqual(result.cards[0].imageUrl, result.cards[1].imageUrl);
});
test("nova consulta reflete foto e preço alterados em cada cartão", async () => {
  const page = catalog(2);
  const red = await photo("#ff0000");
  const blue = await photo("#0000ff");
  const first = await renderCatalog(page, origin, async () => new Response(new Uint8Array(red), { headers: { "content-type": "image/png" } }));
  page.cards[0].text = "Produto real 1\nR$ 25,00 / unidade";
  const second = await renderCatalog(page, origin, async () => new Response(new Uint8Array(blue), { headers: { "content-type": "image/png" } }));
  if (first.type !== "carousel" || second.type !== "carousel") throw new Error("Expected native carousel");
  assert.notEqual(first.cards[0].imageUrl, second.cards[0].imageUrl);
  assert.match(second.cards[0].text, /25,00/);
  assert.match(second.cards[1].text, /20,00/);
});
test("falha no download preserva os cartões e a seleção dos produtos reais", async () => {
  const result = await renderCatalog(catalog(2), origin, async () => new Response(null, { status: 404 }));
  if (result.type !== "carousel") throw new Error("Expected native carousel");
  assert.equal(result.cards[0].options[0].id, "v7:select:0");
  assert.equal(result.cards[1].options[0].id, "v7:select:1");
  assert.ok(result.cards.every((card) => card.imageUrl));
});
test("busca com um único resultado usa cartão de imagem sem inventar outro produto", async () => {
  const result = await renderCatalog(catalog(1), origin, async () => new Response(null, { status: 404 }));
  if (result.type !== "choices") throw new Error("Expected single image card");
  assert.ok(result.imageUrl?.startsWith("data:image/png;base64,"));
  assert.deepEqual(result.options, catalog(1).cards[0].options);
  assert.match(result.text, /Produto real 1/);
});
test("sender entrega carrossel ao transporte, sem converter os produtos numa imagem única", async () => {
  const sent: BotMessage[] = [];
  const sender = catalogSender(origin, async (_account, _waId, message) => {
    sent.push(message);
    return { status: "accepted", providerMessageId: "accepted" };
  });
  const page = catalog(2);
  page.cards.forEach((card) => { card.imageUrl = null; });
  assert.equal((await sender("test", "5511999990000", page)).status, "accepted");
  assert.equal(sent[0].type, "carousel");
  if (sent[0].type !== "carousel") throw new Error("Expected native carousel");
  assert.equal(sent[0].cards.length, 2);
});
test("mais de dez cartões falha antes do envio e Pix literal permanece intacto", async () => {
  const sent: BotMessage[] = [];
  const sender = catalogSender(origin, async (_account, _waId, message) => {
    sent.push(message);
    return { status: "accepted", providerMessageId: "accepted" };
  });
  const invalid = await sender("test", "5511999990000", catalog(11));
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.error, "CATALOG_RENDER_FAILED");
  assert.equal(sent.length, 0);
  const pix: BotMessage = { type: "text", text: "000201-PIX", literal: true };
  await sender("test", "5511999990000", pix);
  assert.deepEqual(sent, [pix]);
});
test("cartões com botões inconsistentes são recusados antes de buscar as imagens", async () => {
  const page = catalog(2);
  page.cards[1].options.pop();
  let requests = 0;
  await assert.rejects(() => renderCatalog(page, origin, async () => { requests++; throw new Error("UNEXPECTED_FETCH"); }), /CATALOG_CARD_OPTIONS_INVALID/);
  assert.equal(requests, 0);
});
