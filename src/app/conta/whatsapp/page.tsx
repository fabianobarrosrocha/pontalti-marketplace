import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { revokeWhatsAppLink } from "./actions";

export const metadata: Metadata = { title: "Meu WhatsApp" };

export default async function WhatsAppAccountPage() {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/conta/whatsapp");
  const { data, error } = await getSupabaseService()
    .from("whatsapp_contacts")
    .select("id,wa_id")
    .eq("customer_id", user.id)
    .order("created_at");
  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-3xl font-bold">Meu WhatsApp</h1>
      <p className="mt-3 text-[var(--muted-foreground)]">
        Para vincular, escreva conta na conversa com a Pontalti e abra o link recebido.
      </p>
      {error ? (
        <p className="mt-6">A vinculação está temporariamente indisponível.</p>
      ) : !data?.length ? (
        <p className="mt-6">Nenhum número vinculado.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.map((contact) => (
            <li
              key={contact.id}
              className="flex items-center justify-between rounded-xl border border-[var(--border)] p-4"
            >
              <span>Número terminado em {String(contact.wa_id).slice(-4)}</span>
              <form
                action={async () => {
                  "use server";
                  await revokeWhatsAppLink(contact.id);
                }}
              >
                <button type="submit" className="text-sm underline">
                  Desvincular
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
