import "server-only";

// Notificação interna da empresa via bot do Telegram (Bot API oficial).
// O bot manda mensagens para um grupo/chat fixo (TELEGRAM_INTERNAL_CHAT_ID).
// Sem credenciais configuradas, vira no-op com status "skipped" — nunca quebra
// o fluxo que disparou a notificação.

export type NotifyOutcome = { status: "sent" | "failed" | "skipped"; error?: string };

export async function sendTelegramMessage(text: string): Promise<NotifyOutcome> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_INTERNAL_CHAT_ID;
  if (!token || !chatId) {
    return { status: "skipped", error: "TELEGRAM_BOT_TOKEN / TELEGRAM_INTERNAL_CHAT_ID não configurados" };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const json = (await resp.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!resp.ok || !json?.ok) {
      return { status: "failed", error: json?.description ?? `Telegram respondeu HTTP ${resp.status}` };
    }
    return { status: "sent" };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

// Conteúdo dinâmico (nome de cliente etc.) precisa ser escapado no parse_mode HTML.
export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
