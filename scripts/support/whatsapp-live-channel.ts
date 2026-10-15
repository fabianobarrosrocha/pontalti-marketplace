import { normalizeEvolution } from "../../src/lib/whatsapp/evolution";
import type { BotMessage } from "../../src/lib/whatsapp/types";

export const TEST_BOT_PREFIX = "Pontalti · teste\n";

/** Copyable payment payloads must reach WhatsApp byte for byte. */
export function testMessagePresentation(message: BotMessage): BotMessage {
  if (message.type === "text" && message.literal) return message;
  if (message.type === "image" || message.type === "document")
    return { ...message, caption: TEST_BOT_PREFIX + message.caption };
  const text = message.text
    .replace(/Pagamento também disponível na sua conta: http:\/\/127\.0\.0\.1:3015\/checkout\/pagamento\/[^\s]+/g,
      "Nesta homologação, escolha Abrir boleto ou Pix para continuar nesta conversa.")
    .replace(/\nhttp:\/\/127\.0\.0\.1:3015\/produtos\/[^\s]+$/, "");
  return { ...message, text: TEST_BOT_PREFIX + text };
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};

/** Exclusivo da homologação. O normalizador de produção continua ignorando mensagens próprias. */
export function testChannelMessages(
  payload: unknown,
  options: { account: string; customerNumber: string; selfChat: boolean; startedAt: number; outboundLiteralTexts?: ReadonlySet<string> },
  now = Date.now()
) {
  const body = object(payload);
  if (body.instance !== options.account) throw new Error("INSTANCE_MISMATCH");
  const records = Array.isArray(body.data) ? body.data : [body.data];
  return records.flatMap((record) => {
    const data = object(record);
    const key = object(data.key);
    const remote = String(key.remoteJid ?? "");
    const jid = remote.endsWith("@lid") ? String(key.remoteJidAlt ?? "") : remote;
    if (jid !== options.customerNumber + "@s.whatsapp.net") return [];
    const timestamp = Number(data.messageTimestamp);
    if (!Number.isFinite(timestamp) || timestamp * 1000 < options.startedAt - 1000) return [];
    if (options.selfChat ? key.fromMe !== true : key.fromMe !== false) return [];
    const messages = normalizeEvolution(
      { ...body, data: { ...data, key: { ...key, fromMe: false } } },
      options.account,
      now
    );
    return messages.filter((message) => !message.text.startsWith(TEST_BOT_PREFIX.trim()) &&
      !(options.selfChat && options.outboundLiteralTexts?.has(message.text)));
  });
}
