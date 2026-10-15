"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { resetSchema, type ResetInput } from "@/lib/validation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";

export function ResetForm() {
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetInput>({ resolver: zodResolver(resetSchema) });

  const onSubmit = async (values: ResetInput) => {
    setServerError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/update-password`,
    });
    if (error) {
      setServerError("Não foi possível enviar o email. Tente novamente.");
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-4 py-6 text-center">
        <MailCheck className="mx-auto h-8 w-8 text-[var(--primary)]" />
        <p className="mt-3 font-medium">Email enviado</p>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Se este email estiver cadastrado, você receberá um link para
          redefinir a senha.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...register("email")} />
      </Field>

      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Enviando…" : "Enviar link de recuperação"}
      </Button>
    </form>
  );
}
