import Image from "next/image";
import type { CatalogImage } from "@/types/product";

type Props = {
  image?: CatalogImage | null;
  title: string;
  sku?: string;
  className?: string;
  withLabel?: boolean;
  sizes?: string;
  priority?: boolean;
};

// Imagem real do produto (Supabase Storage) com fallback neutro para
// produtos ainda sem foto cadastrada.
export function ProductImage({
  image,
  title,
  sku,
  className,
  withLabel = false,
  sizes = "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw",
  priority = false,
}: Props) {
  return (
    <div
      className={`relative w-full overflow-hidden rounded-lg bg-[var(--muted)] ${className ?? "aspect-square"}`}
      aria-label={title}
    >
      {image ? (
        <Image
          src={image.url}
          alt={image.alt ?? title}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg viewBox="0 0 200 200" className="h-2/3 w-2/3 opacity-40">
            <ellipse cx="100" cy="105" rx="70" ry="55" fill="currentColor" opacity="0.35" />
            <ellipse cx="100" cy="105" rx="50" ry="38" fill="currentColor" opacity="0.5" />
          </svg>
          <span className="absolute bottom-3 text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            Sem foto
          </span>
        </div>
      )}
      {withLabel && sku && (
        <div className="absolute bottom-2 left-2 rounded-sm bg-black/40 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-white">
          {sku}
        </div>
      )}
    </div>
  );
}
