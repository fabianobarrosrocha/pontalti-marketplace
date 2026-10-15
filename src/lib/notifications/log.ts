import "server-only";
import { getSupabaseService } from "@/lib/supabase/service";
import type { NotifyOutcome } from "./telegram";

// Log unificado em notification_log (migration 0008) — escrita só via service
// role. Falha de log nunca derruba o envio: fica só no console do servidor.

export async function logNotification(input: {
  channel: "telegram" | "whatsapp";
  event: string;
  orderId?: string | null;
  recipient?: string | null;
  outcome: NotifyOutcome;
}): Promise<void> {
  try {
    const { error } = await getSupabaseService().from("notification_log").insert({
      channel: input.channel,
      event: input.event,
      order_id: input.orderId ?? null,
      recipient: input.recipient ?? null,
      status: input.outcome.status,
      error: input.outcome.error ?? null,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error("[notifications] falha ao gravar notification_log:", e);
  }
}
