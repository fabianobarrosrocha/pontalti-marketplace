import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./LoginForm";
import { safeAuthRedirect } from "@/lib/auth-redirect";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ redirectTo?: string; erro?: string }>;
}) {
  const { redirectTo, erro } = await searchParams;

  return (
    <>
      <h1 className="text-2xl font-bold">Entrar</h1>
      <p className="mt-1 text-sm text-[var(--muted-foreground)]">Acesse sua conta para acompanhar pedidos.</p>
      {erro === "link-invalido" && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          O link que você usou é inválido ou expirou. Faça login ou solicite um novo.
        </p>
      )}
      <div className="mt-6">
        <LoginForm redirectTo={redirectTo} />
      </div>
      <p className="mt-6 text-center text-sm text-[var(--muted-foreground)]">
        Ainda não tem conta?{" "}
        <Link
          href={"/auth/signup?redirectTo=" + encodeURIComponent(safeAuthRedirect(redirectTo))}
          className="font-medium text-[var(--primary)] hover:underline"
        >
          Cadastre-se
        </Link>
      </p>
    </>
  );
}
