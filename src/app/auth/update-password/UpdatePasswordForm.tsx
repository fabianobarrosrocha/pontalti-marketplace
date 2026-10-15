"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import { updatePasswordSchema, type UpdatePasswordInput } from "@/lib/validation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";

export function UpdatePasswordForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdatePasswordInput>({ resolver: zodResolver(updatePasswordSchema) });

  const onSubmit = async (values: UpdatePasswordInput) => {
    setServerError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: values.password });
    if (error) {
      setServerError(
        error.message.includes("session")
          ? "O link de recuperação expirou. Solicite um novo em “Esqueci minha senha”."
          : "Não foi possível atualizar a senha. Tente novamente."
      );
      return;
    }
    window.location.assign("/conta");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Nova senha" htmlFor="password" error={errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register("password")}
        />
      </Field>
      <Field
        label="Confirmar nova senha"
        htmlFor="confirmPassword"
        error={errors.confirmPassword?.message}
      >
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          {...register("confirmPassword")}
        />
      </Field>

      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <Button size="lg" className="w-full" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Salvando…" : "Salvar nova senha"}
      </Button>
    </form>
  );
}
