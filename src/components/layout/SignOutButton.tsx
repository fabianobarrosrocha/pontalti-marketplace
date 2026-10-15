"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/auth/actions";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOutAction();
    } finally {
      // Full page load: remonta o CartProvider (carrinho volta ao modo anônimo).
      window.location.assign("/");
    }
  };

  return (
    <button
      type="button"
      aria-label="Sair"
      title="Sair"
      onClick={handleSignOut}
      disabled={busy}
      className="inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
    >
      <LogOut className="h-5 w-5" />
    </button>
  );
}
