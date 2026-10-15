import type { BotMessage } from "./types";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};

export function normalizeEvolution(payload: unknown, expectedAccount: string, now = Date.now()) {
  const body = object(payload);
  if (body.instance !== expectedAccount) throw new Error("INSTANCE_MISMATCH");
  const event = String(body.event ?? "")
    .replace(/[.-]/g, "_")
    .toUpperCase();
  if (event !== "MESSAGES_UPSERT") return [];
  const records = Array.isArray(body.data) ? body.data : [body.data];
  return records.slice(0, 100).flatMap((record) => {
    const data = object(record);
    const key = object(data.key);
    if (key.fromMe !== false || data.type === "append") return [];
    const remote = String(key.remoteJid ?? "");
    const jid = remote.endsWith("@lid") ? String(key.remoteJidAlt ?? "") : remote;
    if (!/^\d{10,15}@s\.whatsapp\.net$/.test(jid)) return [];
    const id = String(key.id ?? "");
    if (!id || id.length > 200) return [];
    const timestamp = Number(data.messageTimestamp);
    if (
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      (timestamp * 1000 < now - 24 * 60 * 60_000 || timestamp * 1000 > now + 5 * 60_000)
    )
      return [];
    let message = object(data.message);
    for (let i = 0; i < 3; i++) {
      const wrapped = object(message.ephemeralMessage ?? message.viewOnceMessage ?? message.viewOnceMessageV2);
      if (!wrapped.message) break;
      message = object(wrapped.message);
    }
    const extended = object(message.extendedTextMessage);
    const buttons = object(message.buttonsResponseMessage);
    const template = object(message.templateButtonReplyMessage);
    const list = object(object(message.listResponseMessage).singleSelectReply);
    const interactive = object(object(message.interactiveResponseMessage).nativeFlowResponseMessage);
    let action: unknown;
    if (typeof interactive.paramsJson === "string" && interactive.paramsJson.length < 4000) {
      try {
        action = object(JSON.parse(interactive.paramsJson)).id;
      } catch {
        /* Formato não reconhecido. */
      }
    }
    const text = buttons.selectedButtonId ?? template.selectedId ?? list.selectedRowId ?? action ?? message.conversation ?? extended.text;
    if (typeof text !== "string" || !text.trim()) return [];
    return [{ account: expectedAccount, waId: jid.split("@")[0], externalId: id, text: text.trim().slice(0, 2000) }];
  });
}

export type SendOutcome = {
  status: "accepted" | "unknown" | "failed" | "pending";
  providerMessageId?: string;
  error?: string;
};

/** Sends native cards and actions. A provider failure never silently changes the design to text links. */
export async function sendEvolution(account: string, waId: string, message: BotMessage): Promise<SendOutcome> {
  if (process.env.WHATSAPP_BOT_SEND_MODE !== "live") return { status: "pending", error: "SEND_DISABLED" };
  if (account !== process.env.EVOLUTION_INSTANCE || !/^\d{10,15}$/.test(waId))
    return { status: "failed", error: "INVALID_DESTINATION" };
  const url = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!url || !apiKey) return { status: "pending", error: "PROVIDER_NOT_CONFIGURED" };
  let endpoint: string;
  let content: RecordValue;
  switch (message.type) {
    case "product":
      return { status: "failed", error: "PRODUCT_PRESENTATION_REQUIRED" };
    case "carousel":
      endpoint = "sendCarousel";
      content = {
        body: message.text.slice(0, 4096),
        cards: message.cards.map((card) => ({
          title: card.title.slice(0, 120),
          body: card.text.slice(0, 1024),
          ...(card.imageUrl ? { imageUrl: card.imageUrl.startsWith("data:image/png;base64,")
            ? card.imageUrl.slice("data:image/png;base64,".length) : card.imageUrl } : {}),
          buttons: card.options.map((option) => ({ type: "reply", displayText: option.label, id: option.id }))
        }))
      };
      break;
    case "choices":
      if (message.imageUrl && (message.options.length > 3 || message.options.some((option) => option.label.length > 20)))
        return { status: "failed", error: "INTERACTIVE_IMAGE_OPTIONS_INVALID" };
      if (message.options.length <= 3 && message.options.every((option) => option.label.length <= 20)) {
        endpoint = "sendButtons";
        content = {
          title: message.text.slice(0, 4096),
          ...(message.imageUrl ? { thumbnailUrl: message.imageUrl.startsWith("data:image/png;base64,")
            ? message.imageUrl.slice("data:image/png;base64,".length) : message.imageUrl } : {}),
          buttons: message.options.map((option) => ({ type: "reply", displayText: option.label, id: option.id }))
        };
      } else {
        endpoint = "sendList";
        content = {
          title: "Pontalti",
          description: message.text.slice(0, 4096),
          footerText: "",
          buttonText: "Escolher opção",
          sections: [{
            title: "Opções",
            rows: message.options.map((option) => ({
              title: option.label.slice(0, 24),
              ...(option.label.length > 24 ? { description: option.label.slice(0, 72) } : {}),
              rowId: option.id
            }))
          }]
        };
      }
      break;
    case "image":
    case "document":
      endpoint = "sendMedia";
      content = {
        mediatype: message.type,
        media: message.type === "image" && message.url.startsWith("data:image/png;base64,")
          ? message.url.slice("data:image/png;base64,".length) : message.url,
        caption: message.caption.slice(0, 1000),
        ...(message.type === "image" && message.url.startsWith("data:image/png;base64,") ? { mimetype: "image/png" } : {}),
        ...(message.type === "document" ? { mimetype: "application/pdf", fileName: message.filename } : {})
      };
      break;
    case "text":
      endpoint = "sendText";
      content = { text: message.text.slice(0, 4096), linkPreview: false };
  }
  try {
    const response = await fetch(
      url.replace(/\/$/, "") + "/message/" + endpoint + "/" + encodeURIComponent(account),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number: waId, ...content }),
        signal: AbortSignal.timeout(message.type === "carousel" ? 45_000 : 15_000),
        cache: "no-store"
      }
    );
    if (response.status === 429) return { status: "pending", error: "RATE_LIMITED" };
    if (!response.ok)
      return { status: response.status >= 500 ? "unknown" : "failed", error: "PROVIDER_HTTP_" + response.status };
    const json = object(await response.json().catch(() => null));
    const id = object(json.key).id;
    return typeof id === "string" && id
      ? { status: "accepted", providerMessageId: id }
      : { status: "unknown", error: "ACCEPTANCE_WITHOUT_ID" };
  } catch {
    return { status: "unknown", error: "SEND_RESULT_UNKNOWN" };
  }
}
