"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { hashChallenge, hashToken } from "@/lib/whatsapp/security";
import { isUuid } from "@/lib/catalog-shared";

export async function claimWhatsAppLink(token: string): Promise<{ code?: string; error?: string }> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: "Link inválido." };
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return { error: "Entre na sua conta para vincular." };
  const code = String(randomInt(100000, 1000000));
  const { error } = await getSupabaseService().rpc("whatsapp_claim_link", {
    p_token_hash: hashToken(token),
    p_customer_id: user.id,
    p_challenge_hash: hashChallenge(hashToken(token), code)
  });
  return error
    ? { error: "Este link expirou ou já foi usado. Solicite outro escrevendo conta no WhatsApp." }
    : { code };
}

export async function revokeWhatsAppLink(contactId: string) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user || !isUuid(contactId)) return;
  const { error } = await getSupabaseService().rpc("whatsapp_unlink", {
    p_contact_id: contactId,
    p_customer_id: user.id
  });
  if (error) throw new Error("Não foi possível desvincular. Tente novamente.");
  revalidatePath("/conta/whatsapp");
}
