"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Trash2, ShoppingBag, Minus, Plus, ArrowRight } from "lucide-react";
import { useCart } from "@/components/cart/CartProvider";
import { getProductsByIds } from "@/lib/catalog";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { ProductImage } from "@/components/product/ProductImage";
import type { Product } from "@/types/product";

export default function CarrinhoPage() {
  const { items, hydrated, updateQuantity, removeItem } = useCart();
  const [products, setProducts] = useState<Map<string, Product> | null>(null);
  const [loadError, setLoadError] = useState(false);

  const ids = useMemo(() => items.map((i) => i.productId), [items]);
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    getProductsByIds(ids)
      .then((found) => {
        if (cancelled) return;
        setLoadError(false);
        setProducts(new Map(found.map((p) => [p.id, p])));
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, idsKey]);

  // Produto que saiu do catálogo (despublicado) é removido do carrinho —
  // mantém o badge do header consistente com o que a página mostra.
  useEffect(() => {
    if (!products) return;
    items.forEach((i) => {
      if (!products.has(i.productId)) removeItem(i.productId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6 lg:px-8">
        <p className="text-[var(--muted-foreground)]">
          Não foi possível carregar o carrinho. Verifique sua conexão e
          recarregue a página.
        </p>
      </div>
    );
  }

  if (!hydrated || (items.length > 0 && products === null)) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6 lg:px-8">
        <p className="text-[var(--muted-foreground)]">Carregando carrinho…</p>
      </div>
    );
  }

  const lineItems = items
    .map((i) => {
      const product = products?.get(i.productId);
      if (!product) return null; // produto despublicado ou id antigo
      return { ...i, product, subtotal: product.price * i.quantity };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const total = lineItems.reduce((acc, li) => acc + li.subtotal, 0);

  if (lineItems.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 lg:px-8">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--muted)]">
          <ShoppingBag className="h-7 w-7 text-[var(--muted-foreground)]" />
        </div>
        <h1 className="mt-6 text-2xl font-bold">Seu carrinho está vazio</h1>
        <p className="mt-2 text-[var(--muted-foreground)]">
          Visite o catálogo para escolher seus bojos e dublados.
        </p>
        <div className="mt-8">
          <Link href="/produtos">
            <Button size="lg">
              Ver catálogo
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
        Seu carrinho
      </h1>
      <p className="mt-2 text-[var(--muted-foreground)]">
        {lineItems.length} {lineItems.length === 1 ? "item" : "itens"}
      </p>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_360px]">
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--background)]">
          {lineItems.map(({ product, quantity, subtotal }) => (
            <li key={product.id} className="flex gap-4 p-4 sm:p-6">
              <Link
                href={`/produtos/${product.slug}`}
                className="w-24 shrink-0 sm:w-28"
              >
                <ProductImage
                  image={product.images[0] ?? null}
                  title={product.title}
                  className="aspect-square"
                  sizes="112px"
                />
              </Link>

              <div className="flex flex-1 flex-col">
                <div className="flex justify-between gap-4">
                  <div>
                    <Link
                      href={`/produtos/${product.slug}`}
                      className="font-semibold hover:text-[var(--primary)]"
                    >
                      {product.title}
                    </Link>
                    <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
                      {product.sku}
                    </div>
                    <div className="mt-1 text-sm text-[var(--muted-foreground)]">
                      {formatMoney(product.price)} · unidade
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(product.id)}
                    aria-label="Remover item"
                    className="h-9 w-9 shrink-0 rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--primary)]"
                  >
                    <Trash2 className="mx-auto h-4 w-4" />
                  </button>
                </div>

                <div className="mt-auto flex items-center justify-between pt-4">
                  <div className="inline-flex items-center rounded-md border border-[var(--border)]">
                    <button
                      type="button"
                      onClick={() => updateQuantity(product.id, quantity - 1)}
                      className="inline-flex h-9 w-9 items-center justify-center hover:bg-[var(--muted)]"
                      aria-label="Diminuir"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-9 text-center text-sm font-semibold">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(product.id, quantity + 1)}
                      className="inline-flex h-9 w-9 items-center justify-center hover:bg-[var(--muted)]"
                      aria-label="Aumentar"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="font-bold">{formatMoney(subtotal)}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <aside className="h-fit rounded-xl border border-[var(--border)] bg-[var(--background)] p-6">
          <h2 className="text-lg font-semibold">Resumo</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Subtotal</dt>
              <dd className="font-medium">{formatMoney(total)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Frete</dt>
              <dd className="text-[var(--muted-foreground)]">
                A combinar
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
            <span className="text-base font-semibold">Total</span>
            <span className="text-xl font-bold text-[var(--primary)]">
              {formatMoney(total)}
            </span>
          </div>
          <Link href="/checkout" className="mt-6 block">
            <Button size="lg" className="w-full">
              Finalizar pedido
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
          <p className="mt-3 text-center text-xs text-[var(--muted-foreground)]">
            Pagamento por Pix ou boleto Cora. O frete a combinar não está incluído neste total.
          </p>
        </aside>
      </div>
    </div>
  );
}
