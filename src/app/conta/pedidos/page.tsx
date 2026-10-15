import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, Package } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Meus pedidos" };

const STATUS_LABELS: Record<string, string> = {
  awaiting_payment: "Aguardando pagamento",
  paid: "Pago — aguardando confirmação",
  pending: "Aguardando confirmação",
  confirmed: "Confirmado",
  in_production: "Em produção",
  shipped: "Enviado",
  delivered: "Entregue",
  payment_expired: "Pagamento expirado",
  cancelled: "Cancelado",
  awaiting_balance_approval: "Aguardando aprovação da Pontalti",
  balance_approved: "Saldo aprovado",
  balance_rejected: "Saldo não aprovado",
  balance_cancelled: "Solicitação de saldo cancelada",
};

const STATUS_STYLES: Record<string, string> = {
  awaiting_payment: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
  pending: "bg-amber-100 text-amber-800",
  confirmed: "bg-blue-100 text-blue-800",
  in_production: "bg-indigo-100 text-indigo-800",
  shipped: "bg-violet-100 text-violet-800",
  delivered: "bg-emerald-100 text-emerald-800",
  payment_expired: "bg-red-100 text-red-800",
  cancelled: "bg-red-100 text-red-800",
  awaiting_balance_approval: "bg-amber-100 text-amber-800",
  balance_approved: "bg-blue-100 text-blue-800",
  balance_rejected: "bg-red-100 text-red-800",
  balance_cancelled: "bg-red-100 text-red-800",
};

export default async function PedidosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/conta/pedidos");

  const { data: orders } = await supabase
    .from("orders")
    .select("id, status, total, created_at, payment_method, balance_debt_cents, order_items(quantity)")
    .eq("customer_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:px-8">
      <Link
        href="/conta"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)]"
      >
        <ChevronLeft className="h-4 w-4" />
        Minha conta
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Meus pedidos</h1>

      {!orders || orders.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-[var(--border)] p-10 text-center">
          <Package className="mx-auto h-8 w-8 text-[var(--muted-foreground)]" />
          <p className="mt-3 text-sm text-[var(--muted-foreground)]">
            Você ainda não fez nenhum pedido.
          </p>
          <div className="mt-6">
            <Link href="/produtos">
              <Button>Ver catálogo</Button>
            </Link>
          </div>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {orders.map((order) => {
            const itemCount = (order.order_items ?? []).reduce(
              (acc: number, i: { quantity: number }) => acc + i.quantity,
              0
            );
            return (
              <li
                key={order.id}
                className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-5"
              >
                <div className="flex-1">
                  <p className="font-mono text-xs uppercase text-[var(--muted-foreground)]">
                    #{order.id.slice(0, 8)}
                  </p>
                  <p className="mt-1 text-sm">
                    {new Date(order.created_at).toLocaleDateString("pt-BR")} ·{" "}
                    {itemCount} {itemCount === 1 ? "item" : "itens"}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[order.status] ?? "bg-[var(--muted)]"}`}
                >
                  {STATUS_LABELS[order.status] ?? order.status}
                </span>
                <span className="font-bold">{formatMoney(Number(order.total))}</span>
                {order.payment_method === "account_balance" && Number(order.balance_debt_cents) > 0 && <span className="text-sm text-amber-800">Dívida deste pedido: {formatMoney(Number(order.balance_debt_cents) / 100)}</span>}
                {(order.status === "awaiting_payment" || order.payment_method === "account_balance") && (
                  <Link href={`/checkout/pagamento/${order.id}`}>
                    <Button size="sm">Ver pagamento</Button>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
