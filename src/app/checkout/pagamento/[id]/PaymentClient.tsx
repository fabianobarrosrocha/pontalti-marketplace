"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Check, Clock, Copy, FileText, Loader2 } from "lucide-react";
import { checkPaymentStatus } from "../../actions";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/Button";

const POLL_MS = 6000;

type Props = {
  orderId: string;
  total: number;
  dueDate: string | null;
  pixEmv: string | null;
  pixQrDataUrl: string | null;
  boletoUrl: string | null;
  boletoDigitable: string | null;
  initialStatus: string;
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
      {copied ? "Copiado!" : label}
    </Button>
  );
}

export function PaymentClient({
  orderId,
  total,
  dueDate,
  pixEmv,
  pixQrDataUrl,
  boletoUrl,
  boletoDigitable,
  initialStatus
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const redirectingRef = useRef(false);
  const refreshedPaymentRef = useRef(false);

  useEffect(() => {
    const tick = async () => {
      const result = await checkPaymentStatus(orderId);
      if (!result.ok) return;
      setStatus(result.status);
      if (
        ["pending_issue", "pending_review"].includes(initialStatus) &&
        !["pending_issue", "pending_review"].includes(result.status) &&
        !refreshedPaymentRef.current
      ) {
        refreshedPaymentRef.current = true;
        router.refresh();
      }
      if (result.orderStatus !== "awaiting_payment" && !redirectingRef.current) {
        redirectingRef.current = true;
        router.push(`/checkout/sucesso/${orderId}`);
      }
    };
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => clearInterval(interval);
  }, [orderId, router, initialStatus]);

  const dueLabel = dueDate ? new Date(`${dueDate}T12:00:00`).toLocaleDateString("pt-BR") : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold tracking-tight">Pagamento</h1>
      <p className="mt-2 text-[var(--muted-foreground)]">
        Pedido <span className="font-mono font-semibold">#{orderId.slice(0, 8)}</span> · Total{" "}
        <span className="font-semibold text-[var(--foreground)]">{formatMoney(total)}</span>
        {dueLabel && <> · Vence em {dueLabel}</>}
      </p>

      <div className="mt-4 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/50 px-4 py-3 text-sm">
        {status === "pending_review" ? (
          <>
            <Clock className="h-4 w-4 text-[var(--primary)]" />
            Pedido registrado. A cobrança ainda precisa de confirmação; os dados de pagamento aparecerão aqui quando
            estiverem disponíveis.
          </>
        ) : status === "pending_issue" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
            Pedido registrado. Estamos verificando a geração do pagamento; aguarde a cobrança deste pedido.
          </>
        ) : status === "in_payment" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
            Pagamento em processamento — aguarde alguns instantes…
          </>
        ) : (
          <>
            <Clock className="h-4 w-4 text-[var(--primary)]" />
            Aguardando pagamento. Esta página atualiza sozinha quando o pagamento for confirmado.
          </>
        )}
      </div>

      {!["pending_issue", "pending_review"].includes(initialStatus) && (
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-6">
            <h2 className="text-lg font-semibold">Pix</h2>
            {pixQrDataUrl && pixEmv ? (
              <>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">Escaneie o QR Code ou use o copia-e-cola.</p>
                <div className="mt-4 flex justify-center">
                  <Image
                    src={pixQrDataUrl}
                    alt="QR Code Pix"
                    width={220}
                    height={220}
                    unoptimized
                    className="rounded-md border border-[var(--border)]"
                  />
                </div>
                <div className="mt-4 flex justify-center">
                  <CopyButton value={pixEmv} label="Copiar código Pix" />
                </div>
              </>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted-foreground)]">
                Pix indisponível para esta cobrança — use o boleto ao lado (ele também pode ser pago via app do seu
                banco).
              </p>
            )}
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-6">
            <h2 className="text-lg font-semibold">Boleto</h2>
            {boletoUrl ? (
              <>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  Compensação em até 2 dias úteis após o pagamento.
                </p>
                <div className="mt-4 space-y-3">
                  <a href={boletoUrl} target="_blank" rel="noopener noreferrer" className="block">
                    <Button variant="outline" className="w-full">
                      <FileText className="mr-2 h-4 w-4" />
                      Abrir boleto (PDF)
                    </Button>
                  </a>
                  {boletoDigitable && (
                    <>
                      <p className="break-all rounded-md bg-[var(--muted)] px-3 py-2 font-mono text-xs">
                        {boletoDigitable}
                      </p>
                      <CopyButton value={boletoDigitable} label="Copiar linha digitável" />
                    </>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted-foreground)]">Boleto indisponível para esta cobrança.</p>
            )}
          </section>
        </div>
      )}

      <p className="mt-8 text-center text-xs text-[var(--muted-foreground)]">
        Você pode fechar esta página — o pedido fica em{" "}
        <a href="/conta/pedidos" className="underline hover:text-[var(--primary)]">
          Meus pedidos
        </a>{" "}
        e o pagamento pode ser feito até o vencimento.
      </p>
    </div>
  );
}
