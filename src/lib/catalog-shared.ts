import type { CatalogImage, Product } from "@/types/product";

// Colunas usadas em toda query do catálogo (server e client).
export const CATALOG_SELECT =
  "id, factory_sku, display_title, display_description, display_price, category, seo_slug, product_images(storage_path, alt_text, is_primary, display_order)";

export type CatalogConfigRow = {
  id: string;
  factory_sku: string;
  display_title: string;
  display_description: string | null;
  display_price: number | string;
  category: string | null;
  seo_slug: string | null;
  product_images:
    | {
        storage_path: string;
        alt_text: string | null;
        is_primary: boolean;
        display_order: number;
      }[]
    | null;
};

export const productImageUrl = (storagePath: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL) =>
  `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}`;

export function mapConfigRow(row: CatalogConfigRow): Product {
  return mapCatalogConfig(row, process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function mapCatalogConfig(row: CatalogConfigRow, supabaseUrl: string | undefined): Product {
  const images: CatalogImage[] = (row.product_images ?? [])
    .slice()
    .sort((a, b) =>
      a.is_primary !== b.is_primary
        ? Number(b.is_primary) - Number(a.is_primary)
        : a.display_order - b.display_order
    )
    .map((img) => ({
      url: productImageUrl(img.storage_path, supabaseUrl),
      alt: img.alt_text,
      isPrimary: img.is_primary,
    }));

  return {
    id: row.id,
    slug: row.seo_slug ?? row.id,
    sku: row.factory_sku,
    title: row.display_title,
    description: row.display_description,
    price: Number(row.display_price),
    category: row.category,
    images,
  };
}

export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
