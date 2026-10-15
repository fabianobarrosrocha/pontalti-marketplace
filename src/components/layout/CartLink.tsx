"use client";

import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { useCart } from "@/components/cart/CartProvider";

export function CartLink() {
  const { totalCount, hydrated } = useCart();

  return (
    <Link
      href="/carrinho"
      aria-label="Carrinho"
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--foreground)] hover:bg-[var(--muted)]"
    >
      <ShoppingBag className="h-5 w-5" />
      {hydrated && totalCount > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-semibold text-[var(--primary-foreground)]">
          {totalCount}
        </span>
      )}
    </Link>
  );
}
