import type { Metadata } from "next";
import Link from "next/link";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = { title: "Recuperar senha" };

export default function ResetPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">Recuperar senha</h1>
      <p className="mt-1 text-sm text-[var(--muted-foreground)]">
        Informe seu email e enviaremos um link para redefinir a senha.
      </p>
      <div className="mt-6">
        <ResetForm />
      </div>
      <p className="mt-6 text-center text-sm text-[var(--muted-foreground)]">
        Lembrou a senha?{" "}
        <Link href="/auth/login" className="font-medium text-[var(--primary)] hover:underline">
          Entrar
        </Link>
      </p>
    </>
  );
}
