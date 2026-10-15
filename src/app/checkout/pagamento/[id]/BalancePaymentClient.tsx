"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/lib/format";
import type { CustomerBalance } from "@/lib/commerce/customer-finance";
import { checkPaymentStatus, readOrderAccountBalance, confirmUpdatedBalance } from "../../actions";

export function BalancePaymentClient({ orderId, total, initialStatus, debtCents, environment }: {
  orderId: string; total: number; initialStatus: string; debtCents: number; environment: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CustomerBalance | null>(null);
  const [ownReserved, setOwnReserved] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      const result = await checkPaymentStatus(orderId);
      if (!mounted || !result.ok) return;
      setStatus(result.status);
      if (result.orderStatus !== "awaiting_balance_approval") router.refresh();
    };
    const timer = setInterval(() => void poll(), 15_000);
    void poll();
    return () => { mounted = false; clearInterval(timer); };
  }, [orderId, router]);
  const review = async () => {
    setBusy(true); setError(null);
    const result = await readOrderAccountBalance(orderId);
    setBusy(false);
    if (result.ok) { setSummary(result.summary); setOwnReserved(result.ownReservedCents); } else setError(result.error);
  };
  const confirm = async () => {
    if (!summary) return;
    setBusy(true); setError(null);
    const result = await confirmUpdatedBalance(orderId, {
      account_revision: summary.account_revision,
      projected_balance_cents: summary.available_cents + ownReserved - Math.round(total * 100)
    });
    setBusy(false);
    if (result.ok) { setSummary(null); setStatus("awaiting_balance_approval"); router.refresh(); }
    else setError(result.error ?? "Não foi possível confirmar.");
  };
  const labels: Record<string, string> = {
    awaiting_balance_approval: "Aguardando aprovação da Pontalti",
    balance_review: "Revise seu novo saldo",
    balance_approved: "Uso de saldo aprovado",
    balance_rejected: "Pagamento com saldo não aprovado",
    balance_cancelled: "Solicitação cancelada",
    confirmed: "Pedido confirmado", registered: "Registrado na fábrica", in_production: "Em produção",
    shipped: "Pedido enviado", delivered: "Pedido entregue", cancelled: "Pedido cancelado"
  };
  const projected = summary ? summary.available_cents + ownReserved - Math.round(total * 100) : 0;
  const approved = ["balance_approved", "confirmed", "registered", "in_production", "shipped", "delivered"].includes(status);
  return <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
    <h1 className="text-3xl font-bold">{labels[status] ?? "Pagamento com saldo na conta"}</h1>
    <p className="mt-3 text-[var(--muted-foreground)]">Pedido #{orderId.slice(0, 8)} · {formatMoney(total)}</p>
    {environment === "STAGE" && <p className="mt-4 text-amber-800">Ambiente de teste: nenhuma movimentação real.</p>}
    <div className="mt-6 rounded-xl border border-[var(--border)] p-6">
      {approved ? <>
        <p>O pedido está liberado para continuar. O saldo disponível foi utilizado e a parte financiada foi registrada como dívida.</p>
        <p className="mt-3 font-semibold">Dívida deste pedido: {formatMoney(debtCents / 100)}</p>
      </> : ["balance_rejected", "balance_cancelled", "cancelled"].includes(status) ?
        <p>O pedido não foi liberado. Nenhuma dívida permanece por esta solicitação. Consulte a Pontalti para escolher outra forma de pagamento.</p> :
        <p>A continuidade deste pedido depende de aprovação da Pontalti. Produção e envio ficam bloqueados enquanto a análise estiver pendente.
          A dívida só será efetivada na aprovação.</p>}
      {status === "balance_review" && <div className="mt-4">
        <p>Seu saldo mudou desde a confirmação. Precisamos da sua confirmação sobre os valores atuais.</p>
        {!summary ? <Button className="mt-4" onClick={review} disabled={busy}>Revisar saldo</Button> : <>
          <p className="mt-4">Saldo disponível: <strong>{formatMoney(summary.available_cents / 100)}</strong></p>
          {ownReserved > 0 && <p>Já reservado neste pedido: <strong>{formatMoney(ownReserved / 100)}</strong></p>}
          <p>Saldo previsto após a compra: <strong>{formatMoney(projected / 100)}</strong></p>
          {projected < 0 && <p className="mt-2 text-amber-800">Saldo devedor previsto: {formatMoney(-projected / 100)}. Depende da aprovação da Pontalti.</p>}
          <Button className="mt-4" onClick={confirm} disabled={busy}>{busy ? "Confirmando…" : projected < 0 ? "Solicitar aprovação destes valores" : "Confirmar com este saldo"}</Button>
        </>}
      </div>}
      {error && <p className="mt-4 text-red-700" role="alert">{error}</p>}
    </div>
    <div className="mt-6 flex flex-wrap gap-3"><Link href="/conta/pedidos"><Button>Meus pedidos</Button></Link>
      <Link href="/conta/saldo"><Button variant="outline">Meu saldo</Button></Link></div>
  </div>;
}
