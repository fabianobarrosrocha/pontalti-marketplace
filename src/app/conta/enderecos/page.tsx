import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { AddressManager, type Address } from "./AddressManager";

export const metadata: Metadata = { title: "Endereços" };

export default async function EnderecosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/conta/enderecos");

  const { data } = await supabase
    .from("customer_addresses")
    .select("id, zip_code, street, number, complement, neighborhood, city, state, is_default")
    .eq("customer_id", user.id)
    .is("archived_at", null)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:px-8">
      <Link
        href="/conta"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)]"
      >
        <ChevronLeft className="h-4 w-4" />
        Minha conta
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Endereços</h1>
      <p className="mt-2 text-sm text-[var(--muted-foreground)]">
        Endereços de entrega usados no checkout.
      </p>

      <div className="mt-8">
        <AddressManager addresses={(data ?? []) as Address[]} />
      </div>
    </div>
  );
}
