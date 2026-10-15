"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { isUuid } from "@/lib/catalog-shared";
import { clearServerCart, incrementCartItem, mergeAndGetCart, setCartItemQuantity } from "@/lib/cart/actions";

const STORAGE_KEY = "pontalti-cart-v1";
const MERGE_KEY = "pontalti-cart-merge-v1";

export type CartItem = {
  productId: string;
  quantity: number;
};

type CartMode = "anonymous" | "server";

type CartContextValue = {
  items: CartItem[];
  totalCount: number;
  addItem: (productId: string, quantity?: number) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clear: (synchronize?: boolean) => void;
  hydrated: boolean;
};

const CartContext = createContext<CartContextValue | null>(null);

const readLocal = (): CartItem[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CartItem[];
    if (!Array.isArray(parsed)) return [];
    // Descarta entradas inválidas — ex.: ids da fase de dados mockados
    // ("p-001"), que inflavam o badge sem aparecer na página do carrinho.
    return parsed.filter(
      (i) =>
        i && typeof i.productId === "string" && isUuid(i.productId) && Number.isFinite(i.quantity) && i.quantity > 0
    );
  } catch {
    return [];
  }
};

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // Ref (não state): os callbacks de mutação leem o modo sem recriar funções.
  const modeRef = useRef<CartMode>("anonymous");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = readLocal();

      // Sessão lida do cookie (sem rede). Logado → carrinho vive no Supabase.
      const supabase = createClient();
      const {
        data: { session }
      } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session) {
        modeRef.current = "anonymous";
        setItems(local);
        setHydrated(true);
        return;
      }

      try {
        let operationId: string | undefined;
        if (local.length) {
          operationId = window.localStorage.getItem(MERGE_KEY) ?? crypto.randomUUID();
          window.localStorage.setItem(MERGE_KEY, operationId);
        }
        const { items: serverItems } = await mergeAndGetCart(local, operationId);
        if (cancelled) return;
        if (serverItems) {
          modeRef.current = "server";
          setItems(serverItems);
          // O carrinho anônimo foi absorvido pelo banco.
          window.localStorage.removeItem(STORAGE_KEY);
          window.localStorage.removeItem(MERGE_KEY);
        } else {
          modeRef.current = "anonymous";
          setItems(local);
        }
      } catch (err) {
        console.error("Falha ao sincronizar carrinho:", err);
        if (!cancelled) {
          modeRef.current = "anonymous";
          setItems(local);
        }
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || modeRef.current !== "anonymous") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      window.localStorage.removeItem(MERGE_KEY);
    } catch {
      // storage cheio ou indisponível
    }
  }, [items, hydrated]);

  // Atualiza compras iniciadas pelo WhatsApp ao retornar à loja, sem mesclar
  // novamente o carrinho anônimo e sem gravar durante a consulta.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const refresh = async () => {
      if (modeRef.current !== "server" || document.visibilityState !== "visible") return;
      try {
        const result = await mergeAndGetCart([]);
        if (!cancelled && result.items) setItems(result.items);
      } catch {
        /* Preserva o carrinho exibido durante uma indisponibilidade. */
      }
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [hydrated]);

  const syncError = (err: unknown) => console.error("Falha ao sincronizar carrinho:", err);

  const addItem = useCallback((productId: string, quantity = 1) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.productId === productId);
      if (existing) {
        return prev.map((i) => (i.productId === productId ? { ...i, quantity: i.quantity + quantity } : i));
      }
      return [...prev, { productId, quantity }];
    });
    if (modeRef.current === "server") {
      incrementCartItem(productId, quantity).catch(syncError);
    }
  }, []);

  const updateQuantity = useCallback((productId: string, quantity: number) => {
    setItems((prev) =>
      quantity <= 0
        ? prev.filter((i) => i.productId !== productId)
        : prev.map((i) => (i.productId === productId ? { ...i, quantity } : i))
    );
    if (modeRef.current === "server") {
      setCartItemQuantity(productId, quantity).catch(syncError);
    }
  }, []);

  const removeItem = useCallback((productId: string) => {
    setItems((prev) => prev.filter((i) => i.productId !== productId));
    if (modeRef.current === "server") {
      setCartItemQuantity(productId, 0).catch(syncError);
    }
  }, []);

  const clear = useCallback((synchronize = true) => {
    setItems([]);
    if (modeRef.current === "server" && synchronize) {
      clearServerCart().catch(syncError);
    } else {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, []);

  const totalCount = useMemo(() => items.reduce((acc, i) => acc + i.quantity, 0), [items]);

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      totalCount,
      addItem,
      updateQuantity,
      removeItem,
      clear,
      hydrated
    }),
    [items, totalCount, addItem, updateQuantity, removeItem, clear, hydrated]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart deve ser usado dentro de <CartProvider>.");
  return ctx;
}
