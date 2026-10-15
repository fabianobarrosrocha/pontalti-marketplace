"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { signupSchema, type SignupFormValues, type SignupInput } from "@/lib/validation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { safeAuthRedirect } from "@/lib/auth-redirect";

function translateAuthError(message: string): string {
  if (message.includes("already registered")) return "Este email já está cadastrado.";
  if (message.toLowerCase().includes("password")) return "Senha fraca ou inválida.";
  return "Não foi possível criar a conta. Tente novamente.";
}

export function SignupForm({ redirectTo }: { redirectTo?: string }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<SignupFormValues, unknown, SignupInput>({ resolver: zodResolver(signupSchema) });

  const onSubmit = async (values: SignupInput) => {
    setServerError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        emailRedirectTo:
          window.location.origin + "/auth/callback?next=" + encodeURIComponent(safeAuthRedirect(redirectTo)),
        data: {
          full_name: values.fullName,
          phone: values.phone,
          cpf: values.cpf
        }
      }
    });
    if (error) {
      setServerError(translateAuthError(error.message));
      return;
    }
    if (data.session) {
      // Confirmação de email desativada: sessão criada na hora.
      window.location.assign(safeAuthRedirect(redirectTo));
      return;
    }
    // Confirmação de email ativa: Supabase enviou o link.
    setAwaitingConfirmation(true);
  };

  if (awaitingConfirmation) {
    return (
      <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-4 py-6 text-center">
        <MailCheck className="mx-auto h-8 w-8 text-[var(--primary)]" />
        <p className="mt-3 font-medium">Confirme seu email</p>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Enviamos um link de confirmação para o seu email. Depois de confirmar, é só entrar.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Nome completo" htmlFor="fullName" error={errors.fullName?.message}>
        <Input id="fullName" autoComplete="name" {...register("fullName")} />
      </Field>
      <Field label="Email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...register("email")} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Telefone" htmlFor="phone" error={errors.phone?.message} hint="Opcional">
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            placeholder="(11) 99999-9999"
            autoComplete="tel"
            {...register("phone")}
          />
        </Field>
        <Field label="CPF" htmlFor="cpf" error={errors.cpf?.message} hint="Opcional">
          <Input id="cpf" inputMode="numeric" placeholder="000.000.000-00" {...register("cpf")} />
        </Field>
      </div>
      <Field label="Senha" htmlFor="password" error={errors.password?.message}>
        <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
      </Field>
      <Field label="Confirmar senha" htmlFor="confirmPassword" error={errors.confirmPassword?.message}>
        <Input id="confirmPassword" type="password" autoComplete="new-password" {...register("confirmPassword")} />
      </Field>

      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Criando conta…" : "Criar conta"}
      </Button>
    </form>
  );
}
