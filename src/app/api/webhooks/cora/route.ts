import { NextResponse } from "next/server";
import { syncInvoiceStatus } from "@/lib/cora/payment-sync";

// Webhook da Cora (invoice.*). O POST vem SEM corpo e SEM assinatura — apenas
// headers identificando o evento. Por segurança, nunca confiamos no evento:
// usamos o webhook-resource-id apenas como gatilho e confirmamos o status real
// consultando a API da Cora via mTLS (payment-sync).
export async function POST(request: Request) {
  const invoiceId = request.headers.get("webhook-resource-id");
  const eventType = request.headers.get("webhook-event-type") ?? "";

  if (!invoiceId || !invoiceId.startsWith("inv_") || !eventType.startsWith("invoice.")) {
    // Evento que não nos interessa — 200 para a Cora não reenviar.
    return NextResponse.json({ success: true });
  }

  try {
    await syncInvoiceStatus(invoiceId);
  } catch (e) {
    console.error("[webhook cora] falha ao sincronizar", invoiceId, e);
    // 500 faz a Cora reentregar o evento mais tarde.
    return NextResponse.json({ success: false }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
