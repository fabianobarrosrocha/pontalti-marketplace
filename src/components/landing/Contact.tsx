import { Phone, Mail, MapPin, MessageCircle } from "lucide-react";

const contacts = [
  {
    icon: Phone,
    label: "Telefone",
    value: "(00) 0000-0000",
    href: "tel:+5500000000000",
  },
  {
    icon: MessageCircle,
    label: "WhatsApp",
    value: "(00) 00000-0000",
    href: "https://wa.me/5500000000000",
  },
  {
    icon: Mail,
    label: "Email",
    value: "contato@pontalti.com.br",
    href: "mailto:contato@pontalti.com.br",
  },
  {
    icon: MapPin,
    label: "Endereço",
    value: "[Rua / Cidade / Estado]",
    href: null,
  },
];

export function Contact() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
        <div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Fale com a fábrica
          </h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Pedidos personalizados, amostras e prazos de produção: nossa equipe
            atende em horário comercial. WhatsApp é o canal mais rápido.
          </p>

          <div className="mt-8 space-y-4">
            {contacts.map((c) =>
              c.href ? (
                <a
                  key={c.label}
                  href={c.href}
                  className="flex items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 hover:border-[var(--primary)] hover:bg-[var(--muted)]"
                >
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--primary)]">
                    <c.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
                      {c.label}
                    </div>
                    <div className="font-medium">{c.value}</div>
                  </div>
                </a>
              ) : (
                <div
                  key={c.label}
                  className="flex items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"
                >
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--primary)]">
                    <c.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
                      {c.label}
                    </div>
                    <div className="font-medium">{c.value}</div>
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-[var(--border)]">
          <div
            className="h-full min-h-[320px] w-full"
            style={{
              background:
                "linear-gradient(135deg, #002c6d 0%, #00bcd6 60%, #f8f8f8 100%)",
            }}
            aria-hidden
          />
        </div>
      </div>
    </section>
  );
}
