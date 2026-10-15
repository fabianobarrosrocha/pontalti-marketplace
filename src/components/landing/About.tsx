import { Sparkles, ShieldCheck, Truck } from "lucide-react";

const features = [
  {
    icon: Sparkles,
    title: "Acabamento artesanal",
    description:
      "Cada bojo passa por inspeção manual de modelagem e costura. Sem peça em série mal-acabada.",
  },
  {
    icon: ShieldCheck,
    title: "Espumas selecionadas",
    description:
      "Trabalhamos com densidades D28 e D33 vindas de fornecedores homologados. Conforto e durabilidade.",
  },
  {
    icon: Truck,
    title: "Entrega para todo o Brasil",
    description:
      "Atendemos confecções, lojistas e marcas próprias. Pedidos a partir de [N] peças.",
  },
];

export function About() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Por que a Pontalti?
        </h2>
        <p className="mt-4 text-[var(--muted-foreground)]">
          Pequena fábrica, atenção grande aos detalhes. Cada cor, espuma e
          molde do nosso catálogo passou por testes em produção.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-3">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-6"
          >
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--primary)]">
              <f.icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm text-[var(--muted-foreground)]">
              {f.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
