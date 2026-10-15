import Link from "next/link";
import { ArrowRight } from "lucide-react";

const lines = [
  {
    type: "bojo" as const,
    title: "Linha Bojo",
    description:
      "Estrutura com molde para sustentação. Disponível em diferentes densidades de espuma, cores e tamanhos de molde para encaixar em qualquer modelagem.",
    gradient:
      "linear-gradient(135deg, #1a1410 0%, #3a3431 60%, #8b2c3e 100%)",
    cta: "Ver bojos",
    filter: "Bojo",
  },
  {
    type: "dublado" as const,
    title: "Linha Dublado",
    description:
      "Sem molde, com costura interna e externa unificadas. Indicado para tops esportivos, modelagens flexíveis e peças do dia a dia.",
    gradient:
      "linear-gradient(135deg, #c9a47a 0%, #d4b896 60%, #f3e3d0 100%)",
    cta: "Ver dublados",
    filter: "Dublado",
  },
];

export function ProductLines() {
  return (
    <section className="bg-[var(--muted)]">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Duas linhas, uma fábrica
          </h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            A diferença entre bojo e dublado está no molde — e em como a peça
            sustenta o tecido. Veja qual encaixa no seu projeto.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
          {lines.map((line) => (
            <Link
              key={line.type}
              href={`/produtos?categoria=${line.filter}`}
              className="group relative flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)] transition-transform hover:-translate-y-1"
            >
              <div
                className="aspect-[4/3] w-full"
                style={{ background: line.gradient }}
              />
              <div className="flex flex-1 flex-col p-6">
                <h3 className="text-2xl font-bold">{line.title}</h3>
                <p className="mt-3 flex-1 text-sm text-[var(--muted-foreground)]">
                  {line.description}
                </p>
                <div className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--primary)] group-hover:gap-3 transition-all">
                  {line.cta}
                  <ArrowRight className="h-4 w-4" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
