import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { getProductBySlug } from "@/lib/catalog";
import { formatMoney } from "@/lib/format";
import { ProductImage } from "@/components/product/ProductImage";
import { AddToCartControls } from "@/components/product/AddToCartControls";

export const revalidate = 60;

type Params = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Produto não encontrado" };
  return {
    title: product.title,
    description: product.description ?? `Compre ${product.title} na Pontalti.`,
    openGraph: {
      title: product.title,
      description: product.description ?? undefined,
      images: product.images[0] ? [{ url: product.images[0].url }] : undefined,
    },
  };
}

export default async function ProdutoDetalhePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) notFound();

  const [mainImage, ...otherImages] = product.images;

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <Link
        href="/produtos"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--primary)]"
      >
        <ChevronLeft className="h-4 w-4" />
        Voltar ao catálogo
      </Link>

      <div className="mt-6 grid grid-cols-1 gap-12 md:grid-cols-2">
        <div>
          <ProductImage
            image={mainImage ?? null}
            title={product.title}
            className="aspect-square"
            sizes="(max-width: 768px) 100vw, 50vw"
            priority
          />
          {otherImages.length > 0 && (
            <div className="mt-3 grid grid-cols-4 gap-3">
              {otherImages.map((image) => (
                <ProductImage
                  key={image.url}
                  image={image}
                  title={product.title}
                  className="aspect-square"
                  sizes="120px"
                />
              ))}
            </div>
          )}
        </div>

        <div>
          {product.category && (
            <span className="inline-block rounded-full bg-[var(--muted)] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              {product.category}
            </span>
          )}
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
            {product.title}
          </h1>
          <div className="mt-2 font-mono text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
            SKU: {product.sku}
          </div>

          <div className="mt-6 text-3xl font-bold text-[var(--primary)]">
            {formatMoney(product.price)}
          </div>

          {product.description && (
            <p className="mt-6 whitespace-pre-line leading-relaxed text-[var(--foreground)]">
              {product.description}
            </p>
          )}

          <div className="mt-8">
            <AddToCartControls productId={product.id} />
          </div>

          <dl className="mt-10 grid grid-cols-2 gap-4 border-t border-[var(--border)] pt-6 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
                SKU de fábrica
              </dt>
              <dd className="mt-1 font-mono text-xs font-medium uppercase">{product.sku}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
                Categoria
              </dt>
              <dd className="mt-1 font-medium">{product.category ?? "—"}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
