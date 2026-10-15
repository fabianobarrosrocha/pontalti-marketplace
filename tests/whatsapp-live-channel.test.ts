import { test } from "node:test";
import assert from "node:assert/strict";
import { TEST_BOT_PREFIX, testChannelMessages, testMessagePresentation } from "../scripts/support/whatsapp-live-channel";
import type { BotMessage } from "../src/lib/whatsapp/types";

const now = Date.now();
const config = { account: "test-live", customerNumber: "5511999990000", selfChat: false, startedAt: now - 5000 };
const payload = (key = {}, text = "produtos", timestamp = Math.floor(now / 1000)) => ({
  event: "messages.upsert",
  instance: config.account,
  data: {
    key: { id: "phone-message", remoteJid: config.customerNumber + "@s.whatsapp.net", fromMe: false, ...key },
    messageTimestamp: timestamp,
    message: { conversation: text }
  }
});

test("canal ao vivo recebe somente o cliente autorizado e ignora conversas pessoais", () => {
  assert.equal(testChannelMessages(payload(), config, now)[0]?.text, "produtos");
  assert.deepEqual(testChannelMessages(payload({ remoteJid: "5511888880000@s.whatsapp.net" }), config, now), []);
  assert.deepEqual(testChannelMessages(payload({ remoteJid: "group@g.us" }), config, now), []);
  assert.deepEqual(testChannelMessages(payload({ fromMe: true }), config, now), []);
});
test("conversa consigo mesmo exige opção explícita e não reprocessa respostas do bot", () => {
  const self = { ...config, selfChat: true };
  assert.equal(testChannelMessages(payload({ fromMe: true }), self, now)[0]?.text, "produtos");
  assert.deepEqual(testChannelMessages(payload(), self, now), []);
  assert.deepEqual(testChannelMessages(payload({ fromMe: true }, TEST_BOT_PREFIX + "Ver produtos"), self, now), []);
});
test("homologação envia Pix literal sem cabeçalho e ignora o eco desse código no self-chat", () => {
  const pix = "000201-PIX-CORA-COPIA-E-COLA";
  const raw: BotMessage = { type: "text", text: pix, literal: true, customerId: "buyer" };
  assert.deepEqual(testMessagePresentation(raw), raw);
  assert.deepEqual(testMessagePresentation({ type: "text", text: "Copie a próxima mensagem." }), {
    type: "text", text: TEST_BOT_PREFIX + "Copie a próxima mensagem."
  });
  const self = { ...config, selfChat: true, outboundLiteralTexts: new Set([pix]) };
  assert.deepEqual(testChannelMessages(payload({ fromMe: true }, pix), self, now), []);
  assert.equal(testChannelMessages(payload({ fromMe: true }, "menu"), self, now)[0]?.text, "menu");
});
test("ignora histórico, conserva o ID para deduplicação e valida a instância", () => {
  assert.deepEqual(testChannelMessages(payload({}, "menu", Math.floor(now / 1000) - 60), config, now), []);
  const message = testChannelMessages(payload(), config, now)[0];
  assert.equal(message.externalId, "phone-message");
  assert.throws(() => testChannelMessages({ ...payload(), instance: "other" }, config, now), /INSTANCE_MISMATCH/);
});
test("identifica LID apenas quando o telefone alternativo é o cliente autorizado", () => {
  const key = { remoteJid: "123@lid", remoteJidAlt: config.customerNumber + "@s.whatsapp.net" };
  assert.equal(testChannelMessages(payload(key), config, now)[0]?.waId, config.customerNumber);
  assert.deepEqual(testChannelMessages(payload({ remoteJid: "123@lid" }), config, now), []);
});
test("clique nativo na conversa consigo mesmo conserva a ação e a versão", () => {
  const click = payload({ fromMe: true });
  Object.assign(click.data, { message: {
    interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: "v3:select:product" }) } }
  } });
  assert.equal(testChannelMessages(click, { ...config, selfChat: true }, now)[0]?.text, "v3:select:product");
});
test("resposta de botão de cartão é aceita somente do cliente de homologação", () => {
  const click = payload({ fromMe: true });
  Object.assign(click.data, { message: { templateButtonReplyMessage: { selectedId: "v12:select:product", selectedDisplayText: "Escolher produto" } } });
  assert.equal(testChannelMessages(click, { ...config, selfChat: true }, now)[0]?.text, "v12:select:product");
  click.data.key.remoteJid = "5511888880000@s.whatsapp.net";
  assert.deepEqual(testChannelMessages(click, { ...config, selfChat: true }, now), []);
});
