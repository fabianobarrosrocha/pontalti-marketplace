import Link from "next/link";
import { Mail, Phone, MapPin } from "lucide-react";

export function Footer() {
  return (
    <footer
      id="contato"
      className="border-t border-[var(--border)] bg-[var(--muted)] mt-16"
    >
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4 sm:px-6 lg:px-8">
        <div>
          <div className="text-xl font-bold">Pontalti</div>
          <p className="mt-3 text-sm text-[var(--muted-foreground)]">
            Fábrica de bojos e dublados. Produção artesanal e acabamento
            premium para confecções e lojas em todo o Brasil.
          </p>
        </div>

        <div>
          <div className="text-sm font-semibold uppercase tracking-wider">
            Navegação
          </div>
          <ul className="mt-3 space-y-2 text-sm text-[var(--muted-foreground)]">
            <li>
              <Link href="/" className="hover:text-[var(--primary)]">
                Início
              </Link>
            </li>
            <li>
              <Link href="/produtos" className="hover:text-[var(--primary)]">
                Produtos
              </Link>
            </li>
            <li>
              <Link href="/carrinho" className="hover:text-[var(--primary)]">
                Carrinho
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <div className="text-sm font-semibold uppercase tracking-wider">
            Contato
          </div>
          <ul className="mt-3 space-y-2 text-sm text-[var(--muted-foreground)]">
            <li className="flex items-center gap-2">
              <Phone className="h-4 w-4" />
              <a
                href="tel:+5500000000000"
                className="hover:text-[var(--primary)]"
              >
                (00) 0000-0000
              </a>
            </li>
            <li className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              <a
                href="mailto:contato@pontalti.com.br"
                className="hover:text-[var(--primary)]"
              >
                contato@pontalti.com.br
              </a>
            </li>
            <li className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4" />
              <span>[Endereço da fábrica]</span>
            </li>
          </ul>
        </div>

        <div>
          <div className="text-sm font-semibold uppercase tracking-wider">
            Horário
          </div>
          <ul className="mt-3 space-y-1 text-sm text-[var(--muted-foreground)]">
            <li>Segunda a sexta · 8h às 18h</li>
            <li>Sábado · 8h às 12h</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-[var(--border)] py-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 text-xs text-[var(--muted-foreground)] sm:px-6 lg:px-8">
          <span>© {new Date().getFullYear()} Pontalti. Todos os direitos reservados.</span>
          <span>Site em construção</span>
        </div>
      </div>
    </footer>
  );
}
