"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { loginSchema, type LoginInput } from "@/lib/validation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { safeAuthRedirect } from "@/lib/auth-redirect";

function translateAuthError(message: string): string {
  if (message.includes("Invalid login credentials")) return "Email ou senha incorretos.";
  if (message.includes("Email not confirmed"))
    return "Confirme seu email antes de entrar — verifique sua caixa de entrada.";
  return "Não foi possível entrar. Tente novamente.";
}

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (values: LoginInput) => {
    setServerError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password
    });
    if (error) {
      setServerError(translateAuthError(error.message));
      return;
    }
    // Full page load: os Server Components (header, /conta) já enxergam a sessão.
    const target = safeAuthRedirect(redirectTo, "/");
    window.location.assign(target);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...register("email")} />
      </Field>
      <Field label="Senha" htmlFor="password" error={errors.password?.message}>
        <Input id="password" type="password" autoComplete="current-password" {...register("password")} />
      </Field>

      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Entrando…" : "Entrar"}
      </Button>

      <p className="text-center text-sm">
        <Link href="/auth/reset" className="text-[var(--muted-foreground)] hover:text-[var(--primary)]">
          Esqueci minha senha
        </Link>
      </p>
    </form>
  );
}
