import "server-only";
import sharp from "sharp";
import { sendEvolution, type SendOutcome } from "./evolution";
import type { BotMessage, BotProductCard } from "./types";

type Catalog = Extract<BotMessage, { type: "carousel" }>;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function loadPhoto(url: string, origin: string, request: typeof fetch) {
  const image = new URL(url);
  const source = new URL(origin);
  if (image.origin !== source.origin || !image.pathname.startsWith("/storage/v1/object/public/product-images/") ||
    (image.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(image.hostname)))
    throw new Error("INVALID_CATALOG_IMAGE_SOURCE");
  const response = await request(image, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !/^image\/(jpeg|png|webp|avif|gif)(;|$)/i.test(response.headers.get("content-type") ?? "") ||
    Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES || !response.body)
    throw new Error("CATALOG_IMAGE_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("CATALOG_IMAGE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return sharp(Buffer.concat(chunks), { limitInputPixels: 20_000_000 }).rotate()
    .resize(640, 480, { fit: "contain", background: "#ffffff" }).png().toBuffer();
}

function validateCard(card: BotProductCard) {
  if (!card.options.some((option) => option.id.endsWith(":select:" + card.productId)))
    throw new Error("CATALOG_SELECTION_REQUIRED");
  if (!card.options.length || card.options.length > 3 ||
    card.options.some((option) => !option.id || !option.label || option.label.length > 20))
    throw new Error("CATALOG_CARD_OPTIONS_INVALID");
}
async function prepareCard(card: BotProductCard, imageOrigin: string, request: typeof fetch) {
  let photo: Buffer | null = null;
  if (card.imageUrl) {
    try { photo = await loadPhoto(card.imageUrl, imageOrigin, request); } catch { /* Keep the product available without inventing a photo. */ }
  }
  // A missing product photo is clearly labeled, without inventing a replacement.
  const image = photo ?? await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="640" height="480" fill="#ffffff"/>
    <text x="320" y="240" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#68766f">${card.imageUrl ? "Foto indisponível" : "Sem foto cadastrada"}</text>
  </svg>`)).png().toBuffer();
  return { ...card, imageUrl: "data:image/png;base64," + image.toString("base64") };
}
export async function renderProduct(message: Extract<BotMessage, { type: "product" }>, imageOrigin: string, request: typeof fetch = fetch): Promise<BotMessage> {
  validateCard(message);
  const card = await prepareCard(message, imageOrigin, request);
  return { type: "choices", customerId: message.customerId, imageUrl: card.imageUrl, text: message.text, options: message.options };
}

/** Retained for previously queued carousel entries; new catalog replies use individual products. */
export async function renderCatalog(message: Catalog, imageOrigin: string, request: typeof fetch = fetch): Promise<BotMessage> {
  if (!message.cards.length || message.cards.length > 10) throw new Error("CATALOG_REQUIRES_ONE_TO_TEN_PRODUCTS");
  for (const card of message.cards) {
    validateCard(card);
    if (card.options.length !== message.cards[0].options.length) throw new Error("CATALOG_CARD_OPTIONS_INVALID");
  }
  const cards = await Promise.all(message.cards.map((card) => prepareCard(card, imageOrigin, request)));
  // A store/search containing only one product is a regular image card, without fake duplicates.
  if (cards.length === 1) return {
    type: "choices", customerId: message.customerId, imageUrl: cards[0].imageUrl,
    text: message.text + "\n\n" + cards[0].text, options: cards[0].options
  };
  return { ...message, cards };
}

export function catalogSender(imageOrigin: string, send = sendEvolution) {
  return async (account: string, waId: string, message: BotMessage): Promise<SendOutcome> => {
    try {
      const prepared = message.type === "product" ? await renderProduct(message, imageOrigin)
        : message.type === "carousel" ? await renderCatalog(message, imageOrigin) : message;
      return await send(account, waId, prepared);
    } catch {
      return { status: "failed", error: "CATALOG_RENDER_FAILED" };
    }
  };
}
