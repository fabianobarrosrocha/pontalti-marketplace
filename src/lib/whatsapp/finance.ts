import type { BotContext, BotServices, BotState } from "./types";

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
type FinanceContext = {
  api: BotServices; state: BotState; customerId: string | null; context: BotContext;
  say(text: string): void;
  choices(text: string, options: { action: string; label: string }[]): void;
  link(): Promise<void>; showCart(): Promise<void>; showOrder(id: string): Promise<void>;
};
const actions = new Set(["balance", "balance-statement", "balance-review", "balance-confirm", "deposit-new", "deposit-claim", "deposits", "deposit-confirm"]);
export function isFinanceAction(action: string) { return actions.has(action) || action.startsWith("balance-order-review:"); }

export async function financeAction(action: string, ctx: FinanceContext) {
  const { api, state, context, customerId, say, choices } = ctx;
  if (!customerId) return ctx.link();
  if (!api.finance) {
    say("O serviço de saldo ainda não está disponível. Seu carrinho foi preservado.");
    return;
  }
  try {
    if (action === "balance") {
      const summary = await api.finance.summary(customerId);
      state.phase = "menu";
      state.depositInput = undefined;
      choices("Saldo na conta Pontalti\nSaldo atual: " + money(summary.balance_cents) +
        "\nReservado em pedidos: " + money(summary.reserved_cents) +
        "\nSaldo disponível: " + money(summary.available_cents) +
        (summary.available_cents < 0 ? "\nVocê possui saldo devedor. Novas compras precisam de aprovação da Pontalti." : "") +
        (summary.environment === "STAGE" ? "\nAmbiente de teste: estes valores não representam dinheiro real." : ""), [
        { action: "deposit-new", label: "Adicionar saldo" },
        { action: "deposit-claim", label: "Já depositei" },
        { action: "deposits", label: "Meus depósitos" },
        { action: "balance-statement", label: "Extrato do saldo" },
        { action: "catalog:0", label: "Escolher produtos" },
        { action: "menu", label: "Menu" }
      ]);
    } else if (action === "balance-statement") {
      const entries = await api.finance.statement?.(customerId) ?? [];
      choices(entries.length ? "Últimas movimentações do saldo\n" + entries.slice(0, 15).map((entry) =>
        new Date(entry.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) + " · " +
        money(entry.amount_cents) + " · " + (entry.description ?? "Movimentação da conta")
      ).join("\n") : "Não há movimentações de saldo registradas.", [
        { action: "balance", label: "Meu saldo" }, { action: "deposits", label: "Meus depósitos" }
      ]);
    } else if (action === "balance-review" || action.startsWith("balance-order-review:")) {
      const reviewId = action.startsWith("balance-order-review:") ? action.slice("balance-order-review:".length) : undefined;
      const order = reviewId ? await api.order(customerId, reviewId) : null;
      if (reviewId && !order?.balanceNeedsReview) return ctx.showOrder(reviewId);
      if (!reviewId && (!state.preview || state.phase !== "confirm")) return ctx.showCart();
      const summary = await api.finance.summary(customerId);
      const totalCents = order ? order.totalCents : state.preview!.subtotalCents + state.preview!.feeCents;
      const projectedCents = summary.available_cents + (order?.balanceReservedCents ?? 0) - totalCents;
      state.balanceQuote = { availableCents: summary.available_cents, projectedCents, totalCents };
      state.phase = "balance_confirm";
      state.balanceReviewOrderId = reviewId;
      // Store the exact revision and debt projection the customer saw.
      if (state.preview) state.preview.balanceConsent = { account_revision: summary.account_revision, projected_balance_cents: projectedCents };
      if (reviewId) state.preview = { addressId: "", cartVersion: 0, subtotalCents: totalCents, feeCents: 0, delivery: "",
        balanceConsent: { account_revision: summary.account_revision, projected_balance_cents: projectedCents } };
      choices("Pagamento com saldo na conta\nTotal do pedido: " + money(totalCents) +
        "\nSaldo disponível: " + money(summary.available_cents) +
        ((order?.balanceReservedCents ?? 0) > 0 ? "\nJá reservado neste pedido: " + money(order!.balanceReservedCents!) : "") +
        "\nSaldo previsto após a compra: " + money(projectedCents) +
        (projectedCents < 0
          ? "\n\nVocê ficará com saldo devedor de " + money(-projectedCents) +
            ". A continuidade deste pedido depende da aprovação da Pontalti. O pedido não seguirá para produção ou envio enquanto estiver pendente. A dívida só será efetivada na aprovação."
          : "\n\nConfirme para usar seu saldo neste pedido.") +
        (summary.environment === "STAGE" ? "\nAmbiente de teste: nenhuma movimentação real." : ""), [
        { action: "balance-confirm", label: projectedCents < 0 ? "Solicitar aprovação" : "Confirmar com saldo" },
        ...(!reviewId ? [{ action: "address:" + state.preview!.addressId, label: "Outra forma de pagamento" }] : []),
        { action: "cart", label: "Voltar ao carrinho" }
      ]);
    } else if (action === "balance-confirm") {
      if (state.phase !== "balance_confirm" || !state.preview || !state.balanceQuote) return ctx.showCart();
      if (state.balanceReviewOrderId && api.finance.renewConsent) {
        const orderId = state.balanceReviewOrderId;
        await api.finance.renewConsent(customerId, orderId, state.preview.balanceConsent!);
        state.balanceReviewOrderId = undefined;
        state.preview = undefined;
        state.balanceQuote = undefined;
        return ctx.showOrder(orderId);
      }
      const result = await api.finance.checkout(customerId, state.preview, context.conversationId);
      state.preview = undefined;
      state.balanceQuote = undefined;
      state.orderId = result.orderId;
      say(result.status === "APPROVED"
        ? "Uso do saldo confirmado. Consulte abaixo a situação do pedido e eventual dívida."
        : "Solicitação registrada. A continuidade do pedido aguarda a aprovação da Pontalti. A consulta será atualizada automaticamente.");
      return ctx.showOrder(result.orderId);
    } else if (action === "deposit-new" || action === "deposit-claim") {
      state.depositInput = { kind: action === "deposit-new" ? "BOLETO" : "BANK_CLAIM" };
      state.phase = "finance_input";
      choices(action === "deposit-new"
        ? "Qual valor deseja adicionar? Digite em reais, por exemplo 300,00. O boleto será vinculado à sua conta; o saldo será liberado somente após a confirmação do recebimento pelo banco."
        : "Qual foi o valor depositado? Digite em reais, por exemplo 300,00. O aviso ou comprovante sozinho não libera saldo: conferiremos a entrada no banco e o vínculo com seu cadastro.", [
        { action: "balance", label: "Cancelar" }
      ]);
    } else if (action === "deposits") {
      const deposits = await api.finance.deposits(customerId);
      const labels: Record<string, string> = { PENDING: "Em conferência", OPEN: "Aguardando pagamento", UNKNOWN: "Confirmação bancária pendente", CREDITED: "Crédito confirmado", REJECTED: "Não aprovado" };
      choices(deposits.length ? "Seus depósitos\n" + deposits.slice(0, 10).map((d) =>
        "#" + d.id.slice(0, 8) + " · " + money(d.amount_cents) + " · " + (labels[d.status] ?? d.status) +
        (d.boleto_url && d.status === "OPEN" ? "\nBoleto: " + d.boleto_url + (d.digitable ? "\nLinha digitável: " + d.digitable : "") : "")
      ).join("\n\n") : "Você ainda não possui depósitos registrados.", [
        { action: "deposits", label: "Atualizar depósitos" }, { action: "balance", label: "Meu saldo" },
        { action: "deposit-claim", label: "Já depositei" }
      ]);
    } else if (action === "deposit-confirm") {
      const input = state.depositInput;
      if (state.phase !== "finance_confirm" || !input?.amountCents) return;
      const operationId = context.eventId + ":deposit:" + input.kind;
      const deposit = input.kind === "BOLETO"
        ? await api.finance.deposit(customerId, input.amountCents, operationId)
        : await api.finance.claim(customerId, { amountCents: input.amountCents,
          depositedAt: input.depositedAt!, reference: input.reference! }, operationId);
      state.depositInput = undefined;
      state.phase = "menu";
      choices("Solicitação #" + deposit.id.slice(0, 8) + " registrada: " + money(deposit.amount_cents) +
        (deposit.status === "CREDITED" ? "\nCrédito confirmado pelo banco."
          : deposit.boleto_url ? "\nPague o boleto para adicionar saldo. O crédito depende da confirmação bancária.\n" + deposit.boleto_url +
            (deposit.digitable ? "\nLinha digitável: " + deposit.digitable : "")
          : "\nAguardando conferência do recebimento. Nenhum crédito foi liberado por este aviso."), [
        { action: "deposits", label: "Meus depósitos" }, { action: "balance", label: "Meu saldo" }
      ]);
    }
  } catch (error) {
    say(error instanceof Error ? error.message : "Não foi possível consultar o saldo agora.");
    choices("Seu carrinho foi preservado. Você pode consultar novamente ou escolher outra forma de pagamento.", [
      { action: "balance", label: "Consultar saldo" }, { action: "cart", label: "Ver carrinho" }, { action: "menu", label: "Menu" }
    ]);
  }
}

export async function financeInput(text: string, ctx: FinanceContext) {
  const input = ctx.state.depositInput;
  if (!input) return;
  if (!input.amountCents) {
    const value = text.trim().replace(/^R\$\s*/i, "");
    if (!/^\d{1,7}(?:,\d{1,2})?$/.test(value)) return ctx.say("Digite o valor em reais, sem separador de milhar. Exemplo: 300,00.");
    const amount = Math.round(Number(value.replace(",", ".")) * 100);
    if (!Number.isSafeInteger(amount) || amount < 500 || amount > 100_000_000)
      return ctx.say("Informe um valor entre R$ 5,00 e R$ 1.000.000,00.");
    input.amountCents = amount;
  } else if (input.kind === "BANK_CLAIM" && !input.depositedAt) {
    const match = text.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const date = match ? match[3] + "-" + match[2] + "-" + match[1] : "";
    const parsed = new Date(date + "T12:00:00-03:00");
    if (!date || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || parsed.getTime() > Date.now() + 24 * 3600_000)
      return ctx.say("Informe a data válida do depósito como dia/mês/ano. Exemplo: 15/10/2026.");
    input.depositedAt = parsed.toISOString();
  } else if (input.kind === "BANK_CLAIM" && !input.reference) {
    if (text.trim().length < 5 || text.trim().length > 500)
      return ctx.say("Descreva o depósito em 5 a 500 caracteres: banco, identificação do depositante e referência do comprovante. Não envie senha ou código de acesso.");
    input.reference = text.trim();
  }
  if (input.kind === "BANK_CLAIM" && !input.depositedAt)
    return ctx.say("Qual foi a data do depósito? Informe dia/mês/ano, por exemplo 15/10/2026.");
  if (input.kind === "BANK_CLAIM" && !input.reference)
    return ctx.say("Informe banco, identificação do depositante e referência do comprovante. Esses dados serão usados somente para conferência; o saldo depende da entrada confirmada no banco. Não envie senha ou código de acesso.");
  ctx.state.phase = "finance_confirm";
  ctx.choices("Confira antes de continuar\nValor: " + money(input.amountCents!) +
    (input.kind === "BOLETO" ? "\nGerar boleto individual para adicionar saldo à conta Pontalti?"
      : "\nDepósito em " + new Date(input.depositedAt!).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) +
        "\nReferência: " + input.reference + "\nSolicitar conferência? O aviso não confirma pagamento ou libera saldo."), [
    { action: "deposit-confirm", label: input.kind === "BOLETO" ? "Gerar boleto" : "Solicitar conferência" },
    { action: "balance", label: "Cancelar" }
  ]);
}
