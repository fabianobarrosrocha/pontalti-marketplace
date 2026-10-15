import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "./SignupForm";
import { safeAuthRedirect } from "@/lib/auth-redirect";

export const metadata: Metadata = { title: "Criar conta" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ redirectTo?: string }> }) {
  const { redirectTo } = await searchParams;
  const target = safeAuthRedirect(redirectTo);
  return (
    <>
      <h1 className="text-2xl font-bold">Criar conta</h1>
      <p className="mt-1 text-sm text-[var(--muted-foreground)]">Cadastre-se para comprar e acompanhar seus pedidos.</p>
      <div className="mt-6">
        <SignupForm redirectTo={target} />
      </div>
      <p className="mt-6 text-center text-sm text-[var(--muted-foreground)]">
        Já tem conta?{" "}
        <Link
          href={"/auth/login?redirectTo=" + encodeURIComponent(target)}
          className="font-medium text-[var(--primary)] hover:underline"
        >
          Entrar
        </Link>
      </p>
    </>
  );
}
