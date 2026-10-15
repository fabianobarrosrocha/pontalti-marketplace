import "server-only";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

// Client com service role — ignora RLS. Importar APENAS em código server-only
// (webhook, sync de pagamento, notificações); nunca chega ao bundle do cliente.
let adminClient: SupabaseClient | null = null;
export function getSupabaseService(): SupabaseClient {
  if (!adminClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada.");
    adminClient = createSupabaseClient(url, key, { auth: { persistSession: false } });
  }
  return adminClient;
}
