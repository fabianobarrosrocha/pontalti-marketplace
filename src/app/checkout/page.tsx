import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { productImageUrl } from "@/lib/catalog-shared";
import type { Address } from "@/app/conta/enderecos/AddressManager";
import { CheckoutClient, type CheckoutItem } from "./CheckoutClient";

export const metadata: Metadata = { title: "Checkout" };

type CartItemRow = {
  product_config_id: string;
  quantity: number;
  unit_price_snapshot: number | string;
  product_marketplace_config: {
    display_price: number | string;
    is_visible: boolean;
    display_title: string;
    factory_sku: string;
    product_images: { storage_path: string; is_primary: boolean }[];
  } | null;
};

export default async function CheckoutPage() {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?redirectTo=/checkout");

  const [{ data: addresses }, { data: cart }] = await Promise.all([
    supabase
      .from("customer_addresses")
      .select("id, zip_code, street, number, complement, neighborhood, city, state, is_default")
      .eq("customer_id", user.id)
      .is("archived_at", null)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true }),
    supabase
      .from("carts")
      .select(
        "id, version, cart_items(product_config_id, quantity, unit_price_snapshot, product_marketplace_config(display_title, display_price, is_visible, factory_sku, product_images(storage_path, is_primary)))"
      )
      .eq("customer_id", user.id)
      .maybeSingle()
  ]);

  const items: CheckoutItem[] = ((cart?.cart_items ?? []) as unknown as CartItemRow[])
    .filter((i) => i.product_marketplace_config !== null)
    .map((i) => {
      const config = i.product_marketplace_config!;
      const primary = config.product_images.find((img) => img.is_primary) ?? config.product_images[0];
      return {
        productId: i.product_config_id,
        title: config.display_title,
        sku: config.factory_sku,
        quantity: i.quantity,
        unitPrice: Number(config.display_price),
        imageUrl: primary ? productImageUrl(primary.storage_path) : null
      };
    });

  if (
    items.length === 0 ||
    (cart?.cart_items as unknown as CartItemRow[]).some((item) => !item.product_marketplace_config?.is_visible)
  )
    redirect("/carrinho");

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold tracking-tight">Finalizar pedido</h1>
      <p className="mt-2 text-[var(--muted-foreground)]">
        Confira os itens, selecione seu endereço e escolha Pix, boleto ou saldo na conta Pontalti.
        Compras com saldo devedor dependem de aprovação da Pontalti.
      </p>

      <div className="mt-8">
        <CheckoutClient
          addresses={(addresses ?? []) as Address[]}
          items={items}
          cartVersion={Number(cart?.version ?? 0)}
        />
      </div>
    </div>
  );
}
