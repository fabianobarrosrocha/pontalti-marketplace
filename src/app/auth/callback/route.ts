import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeAuthRedirect } from "@/lib/auth-redirect";

// Destino dos links de email do Supabase (confirmação de conta, recuperação
// de senha). Troca o `code` por uma sessão e redireciona para `next`.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/conta";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${safeAuthRedirect(next)}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth/login?erro=link-invalido`);
}
