import { Suspense } from "react";
import type { Metadata } from "next";
import { Search } from "lucide-react";
import { getCatalogCategories, getCatalogProducts } from "@/lib/catalog";
import { ProductCard } from "@/components/catalog/ProductCard";
import { CategoryFilter } from "@/components/catalog/CategoryFilter";

export const revalidate = 60; // catálogo re-gerado a cada 60s

export const metadata: Metadata = {
  title: "Produtos",
  description: "Catálogo de bojos e dublados da fábrica Pontalti.",
};

type SearchParams = { categoria?: string; q?: string };

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { categoria, q } = await searchParams;

  const [categories, products] = await Promise.all([
    getCatalogCategories(),
    getCatalogProducts({ categoria, busca: q }),
  ]);

  const active = categoria && categories.includes(categoria) ? categoria : "Todos";

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="border-b border-[var(--border)] pb-8">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Catálogo
        </h1>
        <p className="mt-3 max-w-2xl text-[var(--muted-foreground)]">
          Linha completa de bojos e dublados. Selecione uma categoria ou busque
          pelo nome.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Suspense fallback={null}>
            <CategoryFilter active={active} categories={categories} />
          </Suspense>
          <form action="/produtos" className="relative ml-auto w-full sm:w-64">
            {active !== "Todos" && (
              <input type="hidden" name="categoria" value={active} />
            )}
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Buscar por título…"
              className="w-full rounded-full border border-[var(--border)] bg-[var(--background)] py-1.5 pl-9 pr-4 text-sm outline-none transition-colors focus:border-[var(--primary)]"
            />
          </form>
        </div>
      </header>

      {products.length === 0 ? (
        <p className="mt-12 text-center text-[var(--muted-foreground)]">
          {q
            ? `Nenhum produto encontrado para “${q}”.`
            : "Nenhum produto encontrado nesta categoria."}
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
