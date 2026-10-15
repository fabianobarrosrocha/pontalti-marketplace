import Link from "next/link";
import type { Product } from "@/types/product";
import { formatMoney } from "@/lib/format";
import { ProductImage } from "@/components/product/ProductImage";

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link
      href={`/produtos/${product.slug}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] transition-all hover:-translate-y-1 hover:border-[var(--primary)]"
    >
      <ProductImage
        image={product.images[0] ?? null}
        title={product.title}
        sku={product.sku}
        className="aspect-[4/5]"
        withLabel
      />

      <div className="flex flex-1 flex-col p-4">
        <span className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
          {product.category ?? "Produto"}
        </span>
        <h3 className="mt-1 line-clamp-2 font-semibold text-[var(--foreground)] group-hover:text-[var(--primary)]">
          {product.title}
        </h3>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-lg font-bold">{formatMoney(product.price)}</span>
          <span className="text-xs font-medium text-[var(--primary)] group-hover:underline">
            Ver detalhes →
          </span>
        </div>
      </div>
    </Link>
  );
}
