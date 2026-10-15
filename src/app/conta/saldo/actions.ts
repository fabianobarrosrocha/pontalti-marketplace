"use server";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/catalog-shared";
import { createBalanceDeposit, createDepositClaim } from "@/lib/commerce/customer-finance";

export async function requestAccountDeposit(input: { key: string; amountCents: number; kind: "BOLETO" | "BANK_CLAIM"; depositedAt?: string; reference?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(input.key)) return { ok: false as const, error: "Sessão expirada. Entre novamente." };
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 500 || input.amountCents > 100_000_000)
    return { ok: false as const, error: "Informe um valor entre R$ 5,00 e R$ 1.000.000,00." };
  try {
    if (input.kind === "BOLETO") return { ok: true as const, deposit: await createBalanceDeposit(user.id, input.amountCents, input.key) };
    if (input.kind !== "BANK_CLAIM" || !input.depositedAt || !/^\d{4}-\d{2}-\d{2}$/.test(input.depositedAt) ||
      !input.reference?.trim() || input.reference.trim().length < 5 || input.reference.length > 500)
      return { ok: false as const, error: "Informe a data e uma referência para conferirmos o depósito." };
    const depositedAt = new Date(input.depositedAt + "T12:00:00-03:00");
    if (Number.isNaN(depositedAt.getTime()) || depositedAt.toISOString().slice(0, 10) !== input.depositedAt ||
      depositedAt.getTime() > Date.now() + 24 * 3600_000)
      return { ok: false as const, error: "Informe uma data válida para o depósito." };
    return { ok: true as const, deposit: await createDepositClaim(user.id, { idempotencyKey: input.key,
      amountCents: input.amountCents, depositedAt: depositedAt.toISOString(), reference: input.reference.trim() }) };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Não foi possível solicitar o depósito." }; }
}
