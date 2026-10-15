import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CATALOG_SELECT,
  isUuid,
  mapConfigRow,
  type CatalogConfigRow,
} from "@/lib/catalog-shared";
import type { Product } from "@/types/product";

// Queries do catálogo público. Usam a anon key sem sessão (dados públicos) —
// o RLS garante que apenas produtos com is_visible = true são retornados.
// Client supabase-js puro: funciona igual em Server Components e no browser
// (página do carrinho), sem depender de cookies.

let catalogClient: SupabaseClient | null = null;
function createClient(): SupabaseClient {
  if (!catalogClient) {
    catalogClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return catalogClient;
}

type CatalogFilters = {
  categoria?: string;
  busca?: string;
};

export async function getCatalogProducts(filters: CatalogFilters = {}): Promise<Product[]> {
  const supabase = createClient();
  let query = supabase
    .from("product_marketplace_config")
    .select(CATALOG_SELECT)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false });

  if (filters.categoria) query = query.eq("category", filters.categoria);
  if (filters.busca) query = query.ilike("display_title", `%${filters.busca}%`);

  const { data, error } = await query;
  if (error) throw new Error(`Erro ao carregar o catálogo: ${error.message}`);
  return ((data ?? []) as CatalogConfigRow[]).map(mapConfigRow);
}

export async function getCatalogCategories(): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("product_marketplace_config")
    .select("category")
    .not("category", "is", null);
  if (error) throw new Error(`Erro ao carregar categorias: ${error.message}`);
  const unique = new Set((data ?? []).map((r) => r.category as string));
  return Array.from(unique).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("product_marketplace_config")
    .select(CATALOG_SELECT)
    .eq("seo_slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Erro ao carregar o produto: ${error.message}`);
  if (data) return mapConfigRow(data as CatalogConfigRow);

  // Produto sem seo_slug é endereçado pelo próprio id.
  if (!isUuid(slug)) return null;
  const byId = await supabase
    .from("product_marketplace_config")
    .select(CATALOG_SELECT)
    .eq("id", slug)
    .maybeSingle();
  if (byId.error) throw new Error(`Erro ao carregar o produto: ${byId.error.message}`);
  return byId.data ? mapConfigRow(byId.data as CatalogConfigRow) : null;
}

export async function getProductsByIds(ids: string[]): Promise<Product[]> {
  const validIds = ids.filter(isUuid); // ignora ids antigos (ex.: carrinho da fase mock)
  if (validIds.length === 0) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("product_marketplace_config")
    .select(CATALOG_SELECT)
    .in("id", validIds);
  if (error) throw new Error(`Erro ao carregar itens do carrinho: ${error.message}`);
  return ((data ?? []) as CatalogConfigRow[]).map(mapConfigRow);
}
