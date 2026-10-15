"use client";

import { useState } from "react";
import { MapPin, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { addressSchema, type AddressFormValues, type AddressInput } from "@/lib/validation";
import { deleteAddress, saveAddress, setDefaultAddress } from "../actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";

export type Address = {
  id: string;
  zip_code: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  is_default: boolean;
};

const formatCep = (cep: string) =>
  cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;

export function AddressForm({
  address,
  onDone,
}: {
  address: Address | null;
  onDone: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AddressFormValues, unknown, AddressInput>({
    resolver: zodResolver(addressSchema),
    defaultValues: address
      ? {
          zipCode: address.zip_code,
          street: address.street,
          number: address.number,
          complement: address.complement ?? "",
          neighborhood: address.neighborhood,
          city: address.city,
          state: address.state,
          isDefault: address.is_default,
        }
      : { isDefault: false },
  });

  const lookupCep = async (raw: string) => {
    const cep = raw.replace(/\D/g, "");
    if (cep.length !== 8) return;
    try {
      const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const data = await resp.json();
      if (data.erro) return;
      if (data.logradouro) setValue("street", data.logradouro, { shouldValidate: true });
      if (data.bairro) setValue("neighborhood", data.bairro, { shouldValidate: true });
      if (data.localidade) setValue("city", data.localidade, { shouldValidate: true });
      if (data.uf) setValue("state", data.uf, { shouldValidate: true });
    } catch {
      // ViaCEP fora do ar — usuário preenche manualmente
    }
  };

  const onSubmit = async (values: AddressInput) => {
    setServerError(null);
    const result = await saveAddress({ ...values, id: address?.id });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    onDone();
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 p-5"
      noValidate
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="CEP" htmlFor="zipCode" error={errors.zipCode?.message}>
          <Input
            id="zipCode"
            inputMode="numeric"
            placeholder="00000-000"
            {...register("zipCode", { onBlur: (e) => lookupCep(e.target.value) })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Rua" htmlFor="street" error={errors.street?.message}>
            <Input id="street" {...register("street")} />
          </Field>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Número" htmlFor="number" error={errors.number?.message}>
          <Input id="number" {...register("number")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Complemento" htmlFor="complement" error={errors.complement?.message} hint="Opcional">
            <Input id="complement" {...register("complement")} />
          </Field>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Bairro" htmlFor="neighborhood" error={errors.neighborhood?.message}>
          <Input id="neighborhood" {...register("neighborhood")} />
        </Field>
        <Field label="Cidade" htmlFor="city" error={errors.city?.message}>
          <Input id="city" {...register("city")} />
        </Field>
        <Field label="UF" htmlFor="state" error={errors.state?.message}>
          <Input id="state" maxLength={2} placeholder="SP" {...register("state")} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" {...register("isDefault")} />
        Usar como endereço padrão
      </label>

      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Salvando…" : address ? "Salvar alterações" : "Adicionar endereço"}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function AddressManager({ addresses }: { addresses: Address[] }) {
  const [editing, setEditing] = useState<Address | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeForm = () => {
    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (id: string) => {
    setActionError(null);
    const result = await deleteAddress(id);
    if (!result.ok) setActionError(result.error);
  };

  const handleSetDefault = async (id: string) => {
    setActionError(null);
    const result = await setDefaultAddress(id);
    if (!result.ok) setActionError(result.error);
  };

  return (
    <div className="space-y-6">
      {addresses.length === 0 && !adding && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
          <MapPin className="mx-auto h-8 w-8 text-[var(--muted-foreground)]" />
          <p className="mt-3 text-sm text-[var(--muted-foreground)]">
            Você ainda não cadastrou nenhum endereço.
          </p>
        </div>
      )}

      {addresses.length > 0 && (
        <ul className="space-y-3">
          {addresses.map((addr) =>
            editing?.id === addr.id ? (
              <li key={addr.id}>
                <AddressForm address={editing} onDone={closeForm} />
              </li>
            ) : (
              <li
                key={addr.id}
                className="flex items-start gap-4 rounded-xl border border-[var(--border)] bg-[var(--background)] p-5"
              >
                <div className="flex-1 text-sm">
                  <p className="font-semibold">
                    {addr.street}, {addr.number}
                    {addr.complement ? ` — ${addr.complement}` : ""}
                  </p>
                  <p className="mt-0.5 text-[var(--muted-foreground)]">
                    {addr.neighborhood} · {addr.city}/{addr.state} · CEP {formatCep(addr.zip_code)}
                  </p>
                  {addr.is_default && (
                    <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-[var(--muted)] px-2 py-0.5 text-xs font-medium text-[var(--primary)]">
                      <Star className="h-3 w-3" />
                      Padrão
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {!addr.is_default && (
                    <button
                      type="button"
                      title="Definir como padrão"
                      onClick={() => handleSetDefault(addr.id)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--primary)]"
                    >
                      <Star className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Editar"
                    onClick={() => {
                      setAdding(false);
                      setEditing(addr);
                    }}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--primary)]"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Remover"
                    onClick={() => handleDelete(addr.id)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            )
          )}
        </ul>
      )}

      {actionError && <p className="text-sm text-red-600">{actionError}</p>}

      {adding ? (
        <AddressForm address={null} onDone={closeForm} />
      ) : (
        !editing && (
          <Button
            variant="outline"
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Adicionar endereço
          </Button>
        )
      )}
    </div>
  );
}
