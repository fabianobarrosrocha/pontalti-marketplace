"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { requestAccountDeposit } from "./actions";

export function DepositForm() {
  const router = useRouter();
  const [kind, setKind] = useState<"BOLETO" | "BANK_CLAIM">("BOLETO");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [reference, setReference] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <form className="mt-6 space-y-4 rounded-xl border border-[var(--border)] p-5" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setMessage("");
    const value = amount.trim();
    if (!/^\d{1,7}(?:,\d{1,2})?$/.test(value)) { setBusy(false); setMessage("Informe o valor como 300,00, sem separador de milhar."); return; }
    const result = await requestAccountDeposit({ key, kind, amountCents: Math.round(Number(value.replace(",", ".")) * 100), depositedAt: date, reference });
    setBusy(false);
    if (!result.ok) setMessage(result.error);
    else { setMessage(result.deposit.boleto_url ? "Boleto gerado. Consulte o link no histórico abaixo." : "Solicitação registrada. O saldo depende da confirmação do recebimento pelo banco.");
      setKey(crypto.randomUUID()); setAmount(""); router.refresh(); }
  }}>
    <h2 className="text-lg font-semibold">Adicionar saldo ou avisar um depósito</h2>
    <label className="block text-sm">Tipo de solicitação<select className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-3" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
      <option value="BOLETO">Gerar boleto para adicionar saldo</option><option value="BANK_CLAIM">Já fiz um depósito</option></select></label>
    <label className="block text-sm">Valor (R$)<input required inputMode="decimal" placeholder="300,00" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] p-3" /></label>
    {kind === "BANK_CLAIM" && <>
      <label className="block text-sm">Data do depósito<input required type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] p-3" /></label>
      <label className="block text-sm">Referência do comprovante<textarea required minLength={5} maxLength={500} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Banco, identificação do depositante e referência do comprovante. Não envie senha ou código de acesso." className="mt-1 w-full rounded-md border border-[var(--border)] p-3" /></label>
    </>}
    <p className="text-sm text-[var(--muted-foreground)]">O crédito será liberado somente após a confirmação bancária. Um aviso ou comprovante, por si só, não confirma o pagamento.</p>
    {message && <p role="status" className="text-sm">{message}</p>}
    <Button disabled={busy}>{busy ? "Enviando…" : kind === "BOLETO" ? "Gerar boleto" : "Solicitar conferência"}</Button>
  </form>;
}
