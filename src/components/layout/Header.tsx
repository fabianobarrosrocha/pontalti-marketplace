import Link from "next/link";
import { UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { CartLink } from "./CartLink";
import { SignOutButton } from "./SignOutButton";

export async function Header() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const firstName =
    (user?.user_metadata?.full_name as string | undefined)?.split(" ")[0] ??
    user?.email?.split("@")[0];

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--background)]/90 backdrop-blur supports-[backdrop-filter]:bg-[var(--background)]/70">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight">Pontalti</span>
          <span className="text-xs uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
            bojos &amp; dublados
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          <Link
            href="/"
            className="text-sm font-medium text-[var(--foreground)] hover:text-[var(--primary)]"
          >
            Início
          </Link>
          <Link
            href="/produtos"
            className="text-sm font-medium text-[var(--foreground)] hover:text-[var(--primary)]"
          >
            Produtos
          </Link>
          <Link
            href="/#contato"
            className="text-sm font-medium text-[var(--foreground)] hover:text-[var(--primary)]"
          >
            Contato
          </Link>
        </nav>

        <div className="flex items-center gap-1">
          {user ? (
            <>
              <Link
                href="/conta"
                className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--muted)]"
              >
                <UserRound className="h-5 w-5" />
                <span className="hidden sm:inline">Olá, {firstName}</span>
              </Link>
              <SignOutButton />
            </>
          ) : (
            <Link
              href="/auth/login"
              className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--muted)]"
            >
              <UserRound className="h-5 w-5" />
              <span className="hidden sm:inline">Entrar</span>
            </Link>
          )}

          <CartLink />
        </div>
      </div>
    </header>
  );
}
