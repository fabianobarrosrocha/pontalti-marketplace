import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/catalog-shared";
import { getSupabaseService } from "@/lib/supabase/service";
import { PaymentClient } from "./PaymentClient";
import { BalancePaymentClient } from "./BalancePaymentClient";

export const metadata: Metadata = { title: "Pagamento" };

export default async function PagamentoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/login?redirectTo=/checkout/pagamento/${id}`);

  const { data: order } = await supabase
    .from("orders")
    .select("id, status, total, payment_method, balance_debt_cents, balance_environment, order_payments(status, pix_qr_code, boleto_url, boleto_digitable, due_date, amount)")
    .eq("id", id)
    .maybeSingle();
  if (!order) notFound();
  if (order.payment_method === "account_balance") {
    const intent = await getSupabaseService().from("checkout_intents").select("status").eq("order_id", order.id)
      .eq("customer_id", user.id).maybeSingle();
    return <BalancePaymentClient orderId={order.id} total={Number(order.total)} debtCents={Number(order.balance_debt_cents ?? 0)}
      environment={order.balance_environment} initialStatus={intent.data?.status === "balance_review" ? "balance_review" : order.status} />;
  }

  // Já pago (ou além): manda direto para a confirmação.
  if (!["awaiting_payment"].includes(order.status)) {
    redirect(`/checkout/sucesso/${order.id}`);
  }

  const payment = (
    order.order_payments as
      | {
          status: string;
          pix_qr_code: string | null;
          boleto_url: string | null;
          boleto_digitable: string | null;
          due_date: string | null;
          amount: number;
        }[]
      | null
  )?.[0];
  const intent = payment
    ? null
    : await getSupabaseService()
        .from("checkout_intents")
        .select("status")
        .eq("order_id", order.id)
        .eq("customer_id", user.id)
        .maybeSingle();

  const pixQrDataUrl = payment?.pix_qr_code
    ? await QRCode.toDataURL(payment.pix_qr_code, { width: 280, margin: 1 })
    : null;

  return (
    <PaymentClient
      orderId={order.id}
      total={Number(payment?.amount ?? order.total)}
      dueDate={payment?.due_date ?? null}
      pixEmv={payment?.pix_qr_code ?? null}
      pixQrDataUrl={pixQrDataUrl}
      boletoUrl={payment?.boleto_url ?? null}
      boletoDigitable={payment?.boleto_digitable ?? null}
      initialStatus={payment?.status ?? (intent?.data?.status === "review" ? "pending_review" : "pending_issue")}
    />
  );
}
