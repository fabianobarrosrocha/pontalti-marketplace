import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-to-br from-[var(--muted)] via-[var(--background)] to-[var(--background)]" />
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-4 py-20 md:grid-cols-2 sm:px-6 lg:px-8 lg:py-28">
        <div>
          <span className="inline-block rounded-full border border-[var(--border)] bg-[var(--background)] px-3 py-1 text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            Fabricação artesanal · Desde [ano]
          </span>
          <h1 className="mt-6 text-4xl font-bold tracking-tight text-[var(--foreground)] sm:text-5xl md:text-6xl">
            Bojos e dublados feitos para{" "}
            <span className="text-[var(--primary)]">vestir bem</span>.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-[var(--muted-foreground)]">
            Há mais de [N] anos a Pontalti produz peças para as melhores
            confecções de lingerie do Brasil. Espumas, moldes e cores cuidadosamente
            selecionados — peça a peça.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/produtos">
              <Button size="lg">
                Ver catálogo
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link href="/#contato">
              <Button variant="outline" size="lg">
                Falar com a fábrica
              </Button>
            </Link>
          </div>
        </div>

        <div className="relative hidden md:block">
          <div className="grid grid-cols-2 gap-4">
            <div
              className="aspect-square rounded-2xl"
              style={{
                background:
                  "linear-gradient(135deg, #002c6d 0%, #003d94 100%)",
              }}
            />
            <div
              className="aspect-square translate-y-8 rounded-2xl"
              style={{
                background:
                  "linear-gradient(135deg, #00bcd6 0%, #7ee5f0 100%)",
              }}
            />
            <div
              className="aspect-square -translate-y-4 rounded-2xl"
              style={{
                background:
                  "linear-gradient(135deg, #1a1410 0%, #3a3431 100%)",
              }}
            />
            <div
              className="aspect-square rounded-2xl"
              style={{
                background:
                  "linear-gradient(135deg, #c9a47a 0%, #f3e3d0 100%)",
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
