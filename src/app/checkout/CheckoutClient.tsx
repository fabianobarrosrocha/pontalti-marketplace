"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { MapPin, Plus, Star } from "lucide-react";
import { useCart } from "@/components/cart/CartProvider";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { AddressForm, type Address } from "@/app/conta/enderecos/AddressManager";
import { createOrder, readAccountBalance } from "./actions";
import type { CustomerBalance } from "@/lib/commerce/customer-finance";

export type CheckoutItem = {
  productId: string;
  title: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  imageUrl: string | null;
};

const formatCep = (cep: string) => (cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);

export function CheckoutClient({
  addresses,
  items,
  cartVersion
}: {
  addresses: Address[];
  items: CheckoutItem[];
  cartVersion: number;
}) {
  const router = useRouter();
  const { clear, totalCount, hydrated } = useCart();
  const [selectedAddress, setSelectedAddress] = useState<string | null>(
    addresses.find((a) => a.is_default)?.id ?? addresses[0]?.id ?? null
  );
  const [addingAddress, setAddingAddress] = useState(addresses.length === 0);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"cora" | "account_balance">("cora");
  const [balance, setBalance] = useState<CustomerBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const subtotal = items.reduce((acc, i) => acc + i.unitPrice * i.quantity, 0);
  const projected = balance ? balance.available_cents - Math.round(subtotal * 100) : null;
  const choosePayment = async (method: "cora" | "account_balance") => {
    setPaymentMethod(method);
    setBalanceError(null);
    if (method !== "account_balance") return;
    setBalanceLoading(true);
    const result = await readAccountBalance();
    setBalanceLoading(false);
    if (result.ok) setBalance(result.summary);
    else { setBalance(null); setBalanceError(result.error); }
  };

  // A página é renderizada no servidor ANTES de o CartProvider mesclar o
  // carrinho anônimo pós-login. Se as contagens divergirem, recarrega os
  // dados do servidor uma vez para mostrar o carrinho mesclado.
  const refreshedRef = useRef(false);
  const serverCount = items.reduce((acc, i) => acc + i.quantity, 0);
  useEffect(() => {
    if (hydrated && !refreshedRef.current && totalCount !== serverCount) {
      refreshedRef.current = true;
      router.refresh();
    }
  }, [hydrated, totalCount, serverCount, router]);

  // Após confirmar, o clear() zera a contagem de propósito — o refresh acima
  // não pode disparar e atropelar a navegação para a página de sucesso.
  const disableRefresh = () => {
    refreshedRef.current = true;
  };

  const handleConfirm = async () => {
    if (!selectedAddress) {
      setServerError("Selecione um endereço de entrega.");
      return;
    }
    setSubmitting(true);
    setServerError(null);
    disableRefresh();
    const result = await createOrder({
      addressId: selectedAddress,
      notes,
      cartVersion,
      subtotalCents: Math.round(subtotal * 100),
      paymentMethod,
      ...(paymentMethod === "account_balance" && balance ? { balanceConsent: {
        account_revision: balance.account_revision, projected_balance_cents: projected!
      } } : {})
    });
    if (!result.ok) {
      setSubmitting(false);
      setServerError(result.error);
      router.refresh();
      return;
    }
    clear(false);
    router.push(`/checkout/pagamento/${result.orderId}`);
  };

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_360px]">
      <div className="space-y-8">
        <section>
          <h2 className="text-lg font-semibold">1. Endereço de entrega</h2>
          {addresses.length > 0 && (
            <ul className="mt-4 space-y-3">
              {addresses.map((addr) => (
                <li key={addr.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
                      selectedAddress === addr.id
                        ? "border-[var(--primary)] bg-[var(--muted)]/40"
                        : "border-[var(--border)] hover:border-[var(--primary)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="address"
                      className="mt-1 h-4 w-4 accent-[var(--primary)]"
                      checked={selectedAddress === addr.id}
                      onChange={() => setSelectedAddress(addr.id)}
                    />
                    <span className="flex-1 text-sm">
                      <span className="font-semibold">
                        {addr.street}, {addr.number}
                        {addr.complement ? ` — ${addr.complement}` : ""}
                      </span>
                      <span className="mt-0.5 block text-[var(--muted-foreground)]">
                        {addr.neighborhood} · {addr.city}/{addr.state} · CEP {formatCep(addr.zip_code)}
                      </span>
                    </span>
                    {addr.is_default && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--muted)] px-2 py-0.5 text-xs font-medium text-[var(--primary)]">
                        <Star className="h-3 w-3" />
                        Padrão
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}

          {addingAddress ? (
            <div className="mt-4">
              <AddressForm
                address={null}
                onDone={() => {
                  setAddingAddress(false);
                  router.refresh();
                }}
              />
            </div>
          ) : (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setAddingAddress(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {addresses.length === 0 ? "Cadastrar endereço" : "Novo endereço"}
            </Button>
          )}

          {addresses.length === 0 && !addingAddress && (
            <p className="mt-3 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <MapPin className="h-4 w-4" />
              Cadastre um endereço para continuar.
            </p>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold">2. Itens do pedido</h2>
          <ul className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
            {items.map((item) => (
              <li key={item.productId} className="flex items-center gap-4 p-4">
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-[var(--muted)]">
                  {item.imageUrl && (
                    <Image src={item.imageUrl} alt={item.title} fill sizes="64px" className="object-cover" />
                  )}
                </div>
                <div className="flex-1">
                  <p className="font-medium">{item.title}</p>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
                    {item.sku}
                  </p>
                  <p className="mt-0.5 text-sm text-[var(--muted-foreground)]">
                    {item.quantity} × {formatMoney(item.unitPrice)}
                  </p>
                </div>
                <span className="font-semibold">{formatMoney(item.unitPrice * item.quantity)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">3. Forma de pagamento</h2>
          <div className="mt-4 space-y-3">
            {([ ["cora", "Pix ou boleto Cora"], ["account_balance", "Saldo na conta Pontalti"] ] as const).map(([value, label]) => (
              <label key={value} className="flex cursor-pointer gap-3 rounded-xl border border-[var(--border)] p-4">
                <input type="radio" name="paymentMethod" checked={paymentMethod === value} onChange={() => void choosePayment(value)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {paymentMethod === "account_balance" && <div className="mt-4 rounded-xl border border-[var(--border)] p-4 text-sm" aria-live="polite">
            {balanceLoading ? "Consultando saldo…" : balanceError ? <p className="text-red-700">{balanceError}</p> : balance && <>
              <p>Saldo disponível: <strong>{formatMoney(balance.available_cents / 100)}</strong></p>
              <p className="mt-1">Saldo previsto após a compra: <strong>{formatMoney(projected! / 100)}</strong></p>
              {projected! < 0 && <p className="mt-3 text-amber-800">Você ficará com saldo devedor de {formatMoney(-projected! / 100)}.
                A continuidade deste pedido depende da aprovação da Pontalti. Produção e envio ficam bloqueados enquanto a análise estiver pendente.
                A dívida só será efetivada na aprovação.</p>}
              {balance.environment === "STAGE" && <p className="mt-2 text-amber-800">Ambiente de teste: estes valores não representam dinheiro real.</p>}
            </>}
          </div>}
        </section>

        <section>
          <h2 className="text-lg font-semibold">4. Observações</h2>
          <textarea
            rows={3}
            maxLength={1000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Alguma observação sobre o pedido? (opcional)"
            className="mt-4 w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm outline-none transition-colors placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]"
          />
        </section>
      </div>

      <aside className="h-fit rounded-xl border border-[var(--border)] bg-[var(--background)] p-6">
        <h2 className="text-lg font-semibold">Resumo</h2>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--muted-foreground)]">Subtotal</dt>
            <dd className="font-medium">{formatMoney(subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--muted-foreground)]">Frete</dt>
            <dd className="text-[var(--muted-foreground)]">A combinar</dd>
          </div>
        </dl>
        <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
          <span className="text-base font-semibold">Total</span>
          <span className="text-xl font-bold text-[var(--primary)]">{formatMoney(subtotal)}</span>
        </div>

        {serverError && <p className="mt-4 text-sm text-red-600">{serverError}</p>}

        <Button size="lg" className="mt-6 w-full" onClick={handleConfirm} disabled={submitting || !selectedAddress ||
          (paymentMethod === "account_balance" && (!balance || balanceLoading))}>
          {submitting ? "Enviando pedido…" : paymentMethod === "account_balance" && projected !== null && projected < 0
            ? "Solicitar aprovação da Pontalti" : "Confirmar pedido"}
        </Button>
        <p className="mt-3 text-center text-xs text-[var(--muted-foreground)]">
          {paymentMethod === "account_balance" ? "O saldo é conferido novamente ao confirmar. " : "Pagamento por Pix ou boleto Cora. "}
          O frete a combinar não está incluído neste total.
        </p>
      </aside>
    </div>
  );
}
