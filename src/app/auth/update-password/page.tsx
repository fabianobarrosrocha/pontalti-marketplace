import type { Metadata } from "next";
import { UpdatePasswordForm } from "./UpdatePasswordForm";

export const metadata: Metadata = { title: "Nova senha" };

export default function UpdatePasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">Definir nova senha</h1>
      <p className="mt-1 text-sm text-[var(--muted-foreground)]">
        Escolha a nova senha da sua conta.
      </p>
      <div className="mt-6">
        <UpdatePasswordForm />
      </div>
    </>
  );
}
