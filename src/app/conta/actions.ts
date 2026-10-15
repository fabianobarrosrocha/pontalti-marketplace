"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  addressSchema,
  profileSchema,
  type AddressInput,
  type ProfileInput,
} from "@/lib/validation";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null as null };
  return { supabase, user };
}

export async function updateProfile(input: ProfileInput): Promise<ActionResult> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Sessão expirada — faça login novamente." };

  const { error } = await supabase
    .from("customers")
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone,
      cpf: parsed.data.cpf,
    })
    .eq("id", user.id);
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Este CPF já está cadastrado em outra conta." };
    return { ok: false, error: error.message };
  }
  revalidatePath("/conta");
  revalidatePath("/conta/perfil");
  return { ok: true };
}

export async function saveAddress(
  input: AddressInput & { id?: string }
): Promise<ActionResult> {
  const parsed = addressSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Sessão expirada — faça login novamente." };

  const row = {
    customer_id: user.id,
    zip_code: parsed.data.zipCode,
    street: parsed.data.street,
    number: parsed.data.number,
    complement: parsed.data.complement || null,
    neighborhood: parsed.data.neighborhood,
    city: parsed.data.city,
    state: parsed.data.state.toUpperCase(),
    is_default: parsed.data.isDefault ?? false,
  };

  // Só pode existir um endereço padrão por cliente.
  if (row.is_default) {
    const { error } = await supabase
      .from("customer_addresses")
      .update({ is_default: false })
      .eq("customer_id", user.id);
    if (error) return { ok: false, error: error.message };
  }

  const { error } = input.id
    ? await supabase.from("customer_addresses").update(row).eq("id", input.id).is("archived_at", null)
    : await supabase.from("customer_addresses").insert(row);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/conta/enderecos");
  revalidatePath("/checkout");
  return { ok: true };
}

export async function deleteAddress(id: string): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Sessão expirada — faça login novamente." };
  const { error } = await supabase.from("customer_addresses").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/conta/enderecos");
  return { ok: true };
}

export async function setDefaultAddress(id: string): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Sessão expirada — faça login novamente." };
  const { error: clearError } = await supabase
    .from("customer_addresses")
      .update({ is_default: false })
    .eq("customer_id", user.id);
  if (clearError) return { ok: false, error: clearError.message };
  const { error } = await supabase
    .from("customer_addresses")
    .update({ is_default: true })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/conta/enderecos");
  return { ok: true };
}
