import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/supabase/service";
import { getInvoice, type CoraInvoice } from "./client";

const STATUS_MAP: Record<string, string> = {
  OPEN: "open",
  DRAFT: "open",
  LATE: "open",
  IN_PAYMENT: "in_payment",
  PAID: "paid",
  CANCELLED: "cancelled"
};
export type SyncResult = { paymentStatus: string; orderStatus: string | null; invoice: CoraInvoice };

/** O webhook é só um gatilho: o estado é confirmado via mTLS e aplicado atomicamente. */
export async function syncInvoiceStatus(
  coraInvoiceId: string,
  db: SupabaseClient = getSupabaseService(),
  gateway: typeof getInvoice = getInvoice
): Promise<SyncResult | null> {
  const known = await db.from("order_payments").select("status").eq("cora_invoice_id", coraInvoiceId).maybeSingle();
  if (known.error) throw new Error("Falha ao consultar pagamento.");
  if (!known.data) return null;
  const invoice = await gateway(coraInvoiceId);
  const { data, error } = await db.rpc("commerce_apply_payment", {
    p_invoice_id: coraInvoiceId,
    p_status: STATUS_MAP[invoice.status] ?? known.data.status,
    p_invoice: invoice
  });
  if (error) throw new Error("Falha ao sincronizar pagamento.");
  return data ? ({ ...data, invoice } as SyncResult) : null;
}
