import { getSupabaseService } from "@/lib/supabase/service";
import { normalizeEvolution } from "@/lib/whatsapp/evolution";
import { matchesSecret } from "@/lib/whatsapp/security";

export const runtime = "nodejs";
const MAX_BYTES = 256 * 1024;

export async function POST(request: Request) {
  if (process.env.WHATSAPP_BOT_ENABLED !== "true") return Response.json({ error: "BOT_DISABLED" }, { status: 503 });
  const provided =
    request.headers.get("x-whatsapp-webhook-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer /, "") ??
    null;
  if (!matchesSecret(provided, process.env.WHATSAPP_WEBHOOK_SECRET))
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const account = process.env.EVOLUTION_INSTANCE;
  if (!account) return Response.json({ error: "INSTANCE_NOT_CONFIGURED" }, { status: 503 });
  if (Number(request.headers.get("content-length")) > MAX_BYTES)
    return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!reader) return Response.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
      }
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = normalizeEvolution(payload, account);
    const db = getSupabaseService();
    let inserted = 0;
    for (const message of messages) {
      const { data, error } = await db.rpc("whatsapp_receive", {
        p_account: message.account,
        p_wa_id: message.waId,
        p_external_id: message.externalId,
        p_text: message.text
      });
      if (error) return Response.json({ error: "PERSISTENCE_FAILED" }, { status: 503 });
      if (data) inserted++;
    }
    return Response.json({ accepted: inserted });
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === "INSTANCE_MISMATCH")) {
      return Response.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    }
    return Response.json({ error: "RECEIVE_FAILED" }, { status: 503 });
  }
}
