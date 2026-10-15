import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, MapPin, Package, UserRound, MessageCircle, Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Minha conta" };

const LINKS = [
  { href: "/conta/saldo", icon: Wallet, title: "Saldo na conta", description: "Saldo disponível, depósitos e compras com saldo" },
  {
    href: "/conta/whatsapp",
    icon: MessageCircle,
    title: "Meu WhatsApp",
    description: "Vincular e gerenciar acesso à sua conta"
  },
  {
    href: "/conta/perfil",
    icon: UserRound,
    title: "Meus dados",
    description: "Nome, telefone e CPF"
  },
  {
    href: "/conta/enderecos",
    icon: MapPin,
    title: "Endereços",
    description: "Endereços de entrega"
  },
  {
    href: "/conta/pedidos",
    icon: Package,
    title: "Pedidos",
    description: "Histórico e acompanhamento"
  }
];

export default async function ContaPage() {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/conta");

  const { data: customer } = await supabase.from("customers").select("full_name").eq("id", user.id).maybeSingle();

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold tracking-tight">Minha conta</h1>
      <p className="mt-2 text-[var(--muted-foreground)]">
        {customer?.full_name || user.email}
        {customer?.full_name && <span className="ml-2 text-sm">({user.email})</span>}
      </p>

      <div className="mt-8 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--background)]">
        {LINKS.map(({ href, icon: Icon, title, description }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-4 p-5 first:rounded-t-xl last:rounded-b-xl hover:bg-[var(--muted)]"
          >
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--muted)] group-hover:bg-[var(--background)]">
              <Icon className="h-5 w-5 text-[var(--primary)]" />
            </span>
            <span className="flex-1">
              <span className="block font-semibold">{title}</span>
              <span className="block text-sm text-[var(--muted-foreground)]">{description}</span>
            </span>
            <ChevronRight className="h-5 w-5 text-[var(--muted-foreground)] group-hover:text-[var(--primary)]" />
          </Link>
        ))}
      </div>
    </div>
  );
}
