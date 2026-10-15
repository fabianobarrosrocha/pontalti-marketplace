"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";

type Props = {
  active: string; // "Todos" ou uma categoria vinda do banco
  categories: string[];
};

export function CategoryFilter({ active, categories }: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const options = ["Todos", ...categories];

  const handleClick = (cat: string) => {
    const next = new URLSearchParams(params.toString());
    if (cat === "Todos") {
      next.delete("categoria");
    } else {
      next.set("categoria", cat);
    }
    const query = next.toString();
    router.push(query ? `/produtos?${query}` : "/produtos");
  };

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => handleClick(cat)}
          className={clsx(
            "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
            active === cat
              ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
              : "border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--primary)]"
          )}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
