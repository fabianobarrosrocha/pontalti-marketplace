"use server";

import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/catalog-shared";

export type CartLine = { productId: string; quantity: number };

async function mutate(lines: CartLine[], mode: "set" | "increment" | "clear", operationId: string = randomUUID()) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return null;
  const valid = lines
    .filter((line) => isUuid(line.productId) && Number.isFinite(line.quantity))
    .map((line) => ({ ...line, quantity: Math.max(-999, Math.min(999, Math.trunc(line.quantity))) }));
  const { data, error } = await supabase.rpc("commerce_my_cart", {
    p_lines: valid,
    p_mode: mode,
    p_operation_id: operationId
  });
  if (error) throw new Error("Não foi possível atualizar o carrinho.");
  return data as { version: number; items: CartLine[] };
}

export async function mergeAndGetCart(
  localItems: CartLine[],
  operationId?: string
): Promise<{ items: CartLine[] | null }> {
  if (!localItems.length) {
    const supabase = await createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) return { items: null };
    const { data, error } = await supabase
      .from("carts")
      .select("cart_items(product_config_id,quantity)")
      .eq("customer_id", user.id)
      .maybeSingle();
    if (error) throw new Error("Não foi possível consultar o carrinho.");
    return {
      items: (data?.cart_items ?? []).map((line: { product_config_id: string; quantity: number }) => ({
        productId: line.product_config_id,
        quantity: line.quantity
      }))
    };
  }
  const result = await mutate(
    localItems.filter((item) => item.quantity > 0),
    "increment",
    operationId
  );
  return { items: result?.items ?? null };
}
export async function setCartItemQuantity(productId: string, quantity: number): Promise<void> {
  await mutate([{ productId, quantity }], "set");
}
export async function incrementCartItem(productId: string, delta: number): Promise<void> {
  await mutate([{ productId, quantity: delta }], "increment");
}
export async function clearServerCart(): Promise<void> {
  await mutate([], "clear");
}
