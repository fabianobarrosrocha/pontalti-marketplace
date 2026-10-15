import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { hashToken, isExpired } from "@/lib/whatsapp/security";
import { LinkAccountForm } from "./LinkAccountForm";

export const metadata: Metadata = {
  title: "Vincular WhatsApp",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default async function LinkWhatsAppPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=" + encodeURIComponent("/conta/whatsapp/vincular/" + token));
  const { data, error } = await getSupabaseService()
    .from("whatsapp_account_links")
    .select("expires_at,confirmed_at,customer_id,whatsapp_contacts(wa_id)")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error || !data) notFound();
  const invalid = isExpired(data.expires_at) || data.confirmed_at || (data.customer_id && data.customer_id !== user.id);
  const contact = data.whatsapp_contacts as unknown as { wa_id: string } | null;
  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-3xl font-bold">Vincular WhatsApp</h1>
      {invalid ? (
        <p className="mt-4">
          Este link expirou ou já foi utilizado. Solicite outro escrevendo conta na conversa com a Pontalti.
        </p>
      ) : (
        <>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Vincule sua conta à conversa com o número terminado em {contact?.wa_id.slice(-4)}. Você poderá comprar,
            consultar pedidos e receber informações de pagamento pelo WhatsApp.
          </p>
          <p className="mt-3 text-sm">
            Continue somente se você iniciou essa solicitação. Sua senha e CPF ficam no cadastro da loja.
          </p>
          <LinkAccountForm token={token} />
        </>
      )}
      <Link href="/conta/whatsapp" className="mt-8 inline-block underline">
        Ver vínculos da minha conta
      </Link>
    </div>
  );
}
