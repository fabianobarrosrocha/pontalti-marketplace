import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/catalog-shared";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Pedido recebido" };

export default async function CheckoutSucessoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: order } = await supabase
    .from("orders")
    .select("id, status, total, created_at, payment_method, order_items(quantity)")
    .eq("id", id)
    .maybeSingle();
  if (!order) notFound();
  if (order.payment_method === "account_balance") redirect("/checkout/pagamento/" + order.id);

  const isPaid = !["awaiting_payment", "pending", "payment_expired", "cancelled"].includes(order.status);

  const itemCount = (order.order_items ?? []).reduce(
    (acc: number, i: { quantity: number }) => acc + i.quantity,
    0
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6 lg:px-8">
      <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
        <CheckCircle2 className="h-8 w-8 text-green-600" />
      </div>
      <h1 className="mt-6 text-3xl font-bold tracking-tight">
        {isPaid ? "Pagamento confirmado!" : "Pedido recebido!"}
      </h1>
      <p className="mt-3 text-[var(--muted-foreground)]">
        Seu pedido{" "}
        <span className="font-mono font-semibold text-[var(--foreground)]">
          #{order.id.slice(0, 8)}
        </span>{" "}
        com {itemCount} {itemCount === 1 ? "item" : "itens"} (
        {formatMoney(Number(order.total))}){" "}
        {isPaid
          ? "está pago. Você pode acompanhar as próximas etapas em Meus pedidos. Em breve entraremos em contato para combinar a entrega."
          : "foi registrado. Em breve entraremos em contato para combinar pagamento e entrega."}
      </p>

      <div className="mt-10 flex flex-wrap justify-center gap-3">
        <Link href="/conta/pedidos">
          <Button size="lg">
            Acompanhar pedido
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
        <Link href="/produtos">
          <Button size="lg" variant="outline">
            Continuar comprando
          </Button>
        </Link>
      </div>
    </div>
  );
}
