import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCustomerBalance, getCustomerStatement, listBalanceDeposits, type CustomerBalance, type DepositClaim, type CustomerAccountEntry } from "@/lib/commerce/customer-finance";
import { formatMoney } from "@/lib/format";
import { DepositForm } from "./DepositForm";

export const metadata: Metadata = { title: "Saldo na conta" };
const statuses: Record<string, string> = { PENDING: "Em conferência", OPEN: "Aguardando pagamento", UNKNOWN: "Confirmação pendente", CREDITED: "Crédito confirmado", REJECTED: "Não aprovado" };
export default async function AccountBalancePage() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/conta/saldo");
  let balance: CustomerBalance | undefined; let deposits: DepositClaim[] = []; let entries: CustomerAccountEntry[] = []; let error: string | undefined;
  try { balance = await getCustomerBalance(user.id); [deposits, entries] = await Promise.all([listBalanceDeposits(user.id), getCustomerStatement(user.id)]); }
  catch (caught) { error = caught instanceof Error ? caught.message : "Saldo indisponível."; }
  return <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
    <Link href="/conta" className="text-sm text-[var(--muted-foreground)]">← Minha conta</Link>
    <h1 className="mt-4 text-3xl font-bold">Saldo na conta Pontalti</h1>
    {error ? <p className="mt-6 rounded-xl border border-amber-300 p-5">{error}</p> : balance && <>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[["Saldo atual", balance.balance_cents], ["Reservado em pedidos", balance.reserved_cents], ["Saldo disponível", balance.available_cents]].map(([label, cents]) =>
          <div key={label} className="rounded-xl border border-[var(--border)] p-5"><p className="text-sm text-[var(--muted-foreground)]">{label}</p><p className="mt-2 text-xl font-semibold">{formatMoney(Number(cents) / 100)}</p></div>)}
      </div>
      {balance.environment === "STAGE" && <p className="mt-4 text-amber-800">Ambiente de teste: estes valores não representam dinheiro real.</p>}
      <p className="mt-4 text-sm text-[var(--muted-foreground)]">Compras que resultarem em saldo negativo precisam da aprovação da Pontalti para continuar. Novos depósitos confirmados abatem a dívida antes de formar saldo disponível.</p>
      <DepositForm />
      <h2 className="mt-8 text-xl font-semibold">Extrato do saldo</h2>
      {!entries.length ? <p className="mt-4 text-sm">Nenhuma movimentação registrada.</p> : <ul className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{entries.slice(0, 50).map((entry) =>
        <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm">{entry.description ?? "Movimentação da conta"}</p><p className="mt-1 text-xs text-[var(--muted-foreground)]">{new Date(entry.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</p></div><strong>{formatMoney(entry.amount_cents / 100)}</strong></li>)}</ul>}
      <h2 className="mt-8 text-xl font-semibold">Histórico de depósitos</h2>
      {!deposits?.length ? <p className="mt-4 text-sm">Nenhum depósito registrado.</p> : <ul className="mt-4 space-y-3">{deposits.map((deposit) =>
        <li key={deposit.id} className="rounded-xl border border-[var(--border)] p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{formatMoney(deposit.amount_cents / 100)}</strong><span>{statuses[deposit.status] ?? deposit.status}</span></div>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">#{deposit.id.slice(0, 8)}</p>
          {deposit.boleto_url && deposit.status === "OPEN" && <><a href={deposit.boleto_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block underline">Abrir boleto</a>{deposit.digitable && <p className="mt-2 break-all font-mono text-xs">{deposit.digitable}</p>}</>}
        </li>)}</ul>}
    </>}
  </div>;
}
