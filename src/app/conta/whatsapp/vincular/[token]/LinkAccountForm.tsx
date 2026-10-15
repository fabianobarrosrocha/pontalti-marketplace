"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { claimWhatsAppLink } from "../../actions";

export function LinkAccountForm({ token }: { token: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (code)
    return (
      <div className="mt-6 rounded-xl border border-[var(--border)] p-6">
        <p className="font-medium">Confirme na conversa que iniciou o vínculo</p>
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          Envie esta mensagem para o assistente Pontalti no WhatsApp:
        </p>
        <p className="mt-3 rounded-lg bg-[var(--muted)] p-4 font-mono text-xl">vincular {code}</p>
        <p className="mt-3 text-sm">
          O vínculo só será ativado depois dessa confirmação. O link expira em 15 minutos após sua emissão.
        </p>
      </div>
    );
  return (
    <div className="mt-6">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await claimWhatsAppLink(token);
            setCode(result.code ?? null);
            setError(result.error ?? null);
          } catch {
            setError("Não foi possível vincular. Tente novamente.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparando confirmação…" : "Vincular minha conta"}
      </Button>
      {error && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
