"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { profileSchema, type ProfileFormValues, type ProfileInput } from "@/lib/validation";
import { updateProfile } from "../actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";

type Props = {
  initial: { fullName: string; phone: string; cpf: string };
};

export function ProfileForm({ initial }: Props) {
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileFormValues, unknown, ProfileInput>({
    resolver: zodResolver(profileSchema),
    defaultValues: initial,
  });

  const onSubmit = async (values: ProfileInput) => {
    setStatus("idle");
    setServerError(null);
    const result = await updateProfile(values);
    if (!result.ok) {
      setStatus("error");
      setServerError(result.error);
      return;
    }
    setStatus("saved");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Nome completo" htmlFor="fullName" error={errors.fullName?.message}>
        <Input id="fullName" autoComplete="name" {...register("fullName")} />
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

      {status === "error" && serverError && (
        <p className="text-sm text-red-600">{serverError}</p>
      )}
      {status === "saved" && (
        <p className="text-sm text-green-700">Dados atualizados com sucesso.</p>
      )}

      <Button size="lg" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Salvando…" : "Salvar alterações"}
      </Button>
    </form>
  );
}
