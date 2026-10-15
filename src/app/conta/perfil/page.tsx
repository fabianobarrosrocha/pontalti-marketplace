import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "./ProfileForm";

export const metadata: Metadata = { title: "Meus dados" };

export default async function PerfilPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/conta/perfil");

  const { data: customer } = await supabase
    .from("customers")
    .select("full_name, phone, cpf")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-6 lg:px-8">
      <Link
        href="/conta"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)]"
      >
        <ChevronLeft className="h-4 w-4" />
        Minha conta
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Meus dados</h1>
      <p className="mt-2 text-sm text-[var(--muted-foreground)]">{user.email}</p>

      <div className="mt-8">
        <ProfileForm
          initial={{
            fullName: customer?.full_name ?? "",
            phone: customer?.phone ?? "",
            cpf: customer?.cpf ?? "",
          }}
        />
      </div>
    </div>
  );
}
