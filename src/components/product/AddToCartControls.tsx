"use client";

import { useState } from "react";
import { Minus, Plus, ShoppingBag, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useCart } from "@/components/cart/CartProvider";

export function AddToCartControls({ productId }: { productId: string }) {
  const { addItem } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [justAdded, setJustAdded] = useState(false);

  const handleAdd = () => {
    addItem(productId, quantity);
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 1800);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="inline-flex items-center rounded-md border border-[var(--border)]">
        <button
          type="button"
          aria-label="Diminuir quantidade"
          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          className="inline-flex h-11 w-11 items-center justify-center text-[var(--foreground)] hover:bg-[var(--muted)] disabled:opacity-50"
          disabled={quantity <= 1}
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="min-w-10 text-center font-semibold">{quantity}</span>
        <button
          type="button"
          aria-label="Aumentar quantidade"
          onClick={() => setQuantity((q) => q + 1)}
          className="inline-flex h-11 w-11 items-center justify-center text-[var(--foreground)] hover:bg-[var(--muted)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <Button size="lg" onClick={handleAdd}>
        {justAdded ? (
          <>
            <Check className="mr-2 h-4 w-4" />
            Adicionado!
          </>
        ) : (
          <>
            <ShoppingBag className="mr-2 h-4 w-4" />
            Adicionar ao carrinho
          </>
        )}
      </Button>
    </div>
  );
}
