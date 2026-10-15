"use server";

import { createClient } from "@/lib/supabase/server";

// Encerra a sessão (limpa os cookies). O redirecionamento fica a cargo do
// client, que faz um full page load — assim o CartProvider e demais estados
// client-side remontam do zero.
export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
