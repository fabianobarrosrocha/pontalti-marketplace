export type CatalogImage = {
  url: string;
  alt: string | null;
  isPrimary: boolean;
};

// Produto do catálogo público, mapeado de `product_marketplace_config`
// (+ `product_images`) no Supabase.
export type Product = {
  id: string; // uuid do product_marketplace_config
  slug: string;
  sku: string;
  title: string;
  description: string | null;
  price: number;
  category: string | null;
  images: CatalogImage[]; // ordenadas: principal primeiro, depois display_order
};
