import Link from "next/link";
import { PackageX, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";

export default function ProdutoNaoEncontrado() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 lg:px-8">
      <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--muted)]">
        <PackageX className="h-7 w-7 text-[var(--muted-foreground)]" />
      </div>
      <h1 className="mt-6 text-2xl font-bold">Produto não encontrado</h1>
      <p className="mt-2 text-[var(--muted-foreground)]">
        Este produto pode ter sido removido do catálogo ou o endereço está
        incorreto.
      </p>
      <div className="mt-8">
        <Link href="/produtos">
          <Button size="lg">
            Ver catálogo
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
