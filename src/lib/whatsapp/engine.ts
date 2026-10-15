import type { BotContext, BotMessage, BotServices, BotState, BotCart } from "./types";
import { CustomerActionError } from "./types";
import { accountAction, accountInput, showAccount } from "./account";
import QRCode from "qrcode";
import { financeAction, financeInput, isFinanceAction } from "./finance";

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const clean = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
const statuses: Record<string, string> = {
  awaiting_payment: "Aguardando pagamento",
  paid: "Pagamento confirmado",
  pending: "Pedido recebido",
  confirmed: "Pedido confirmado",
  in_production: "Em produção",
  shipped: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
  payment_expired: "Cobrança cancelada",
  registered: "Registrado na fábrica",
  awaiting_balance_approval: "Aguardando aprovação da Pontalti para usar saldo",
  balance_approved: "Uso de saldo aprovado pela Pontalti",
  balance_rejected: "Pagamento com saldo não aprovado",
  balance_cancelled: "Solicitação de saldo cancelada"
};

/** Motor independente do transporte e do Next; estado e respostas são persistidos pelo worker. */
export async function processConversation(context: BotContext, previous: BotState, api: BotServices) {
  const state: BotState = structuredClone(previous);
  const replies: BotMessage[] = [];
  const standalone = new Set<BotMessage>();
  let customerId = context.customerId;
  const settings = await api.settings();
  if ((state.customerId ?? null) !== customerId) {
    state.preview = undefined;
    state.orderId = undefined;
    state.accountEdit = undefined;
    state.repeat = undefined;
    state.balanceQuote = undefined;
    state.depositInput = undefined;
    state.choices = [];
    state.phase = "menu";
  }
  state.customerId = customerId;
  const say = (text: string, separate = false) => {
    const reply: BotMessage = { type: "text", text };
    if (separate) standalone.add(reply);
    replies.push(reply);
  };
  const choices = (text: string, options: { action: string; label: string }[]) => {
    state.choices = options;
    state.menuVersion = context.version + 1;
    // Keep the explanation and its actions in one WhatsApp bubble.
    while (replies.at(-1)?.type === "text" && !standalone.has(replies.at(-1)!)) {
      const previous = replies.pop() as Extract<BotMessage, { type: "text" }>;
      text = previous.text + "\n\n" + text;
    }
    replies.push({
      type: "choices",
      text,
      options: options.map((option) => ({
        id: "v" + state.menuVersion + ":" + option.action,
        label: option.label
      }))
    });
  };
  const menu = () => {
    state.phase = "menu";
    state.accountEdit = undefined;
    state.repeat = undefined;
    state.preview = undefined;
    state.balanceQuote = undefined;
    state.depositInput = undefined;
    choices("Olá! Sou o assistente da Pontalti. Escolha uma opção ou escreva o que procura.", [
      { action: "catalog:0", label: "Ver produtos" },
      { action: "cart", label: "Carrinho" },
      { action: "orders", label: "Meus pedidos" },
      { action: "repeat:last", label: "Repetir último pedido" },
      { action: "account:home", label: "Meus dados" },
      { action: "payments", label: "Pagar com Pix" },
      { action: "balance", label: "Saldo na conta" },
      { action: "faq", label: "Dúvidas" }
    ]);
  };
  const link = async () => {
    const url = await api.createLink(context.contactId, context.eventId);
    say(
      "Para acessar sua conta e comprar, este número precisa estar vinculado à sua conta da Pontalti.\n" +
        "Já é cliente? Entre na sua conta pelo link seguro abaixo. Se ainda não tem cadastro, escolha Cadastre-se no site para criar sua conta.\n" +
        url +
        "\n\nDepois confirme o vínculo nesta conversa com o código mostrado na página. Seus produtos escolhidos ficam salvos. Não envie CPF ou senha aqui."
    );
  };
  const account = () => ({ api, state, customerId: customerId!, contactId: context.contactId,
    eventId: context.eventId, say, choices });
  const finance = () => ({ api, state, customerId, context, say, choices, link, showCart, showOrder });
  const readCart = async (): Promise<BotCart> => {
    if (customerId) return api.cart(customerId);
    const products = await api.products((state.pending ?? []).map((item) => item.productId));
    const items = (state.pending ?? []).map((item) => {
      const product = products.find((p) => p.id === item.productId);
      return {
        ...item,
        title: product?.title ?? "Produto indisponível",
        priceCents: product?.priceCents ?? 0,
        available: !!product
      };
    });
    return { version: 0, items, subtotalCents: items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0) };
  };
  const showCart = async () => {
    const cart = await readCart();
    state.phase = "cart";
    state.preview = undefined;
    if (!cart.items.length) {
      say("Seu carrinho está vazio.");
      return menu();
    }
    say(
      "Seu carrinho\n" +
        cart.items
          .map(
            (item, index) =>
              index +
              1 +
              ". " +
              item.quantity +
              " × " +
              item.title +
              " — " +
              (item.available ? money(item.priceCents * item.quantity) : "indisponível")
          )
          .join("\n") +
        "\nSubtotal: " +
        money(cart.subtotalCents)
    );
    choices("O que deseja fazer?", [
      { action: "checkout", label: "Continuar compra" },
      { action: "catalog:0", label: "Adicionar produto" },
      ...cart.items.map((item, index) => ({
        action: "edit:" + item.productId,
        label: "Alterar/remover item " + (index + 1)
      })),
      { action: "clear", label: "Esvaziar carrinho" }
    ]);
  };
  const catalog = async (page: number, query = state.query ?? "") => {
    page = Math.max(0, Math.min(1000, Math.floor(page) || 0));
    const result = await api.catalog(query, page);
    state.phase = "catalog";
    state.page = page;
    state.query = query;
    state.catalogIds = result.products.map((product) => product.id);
    if (!result.products.length) {
      if (page > 0) {
        return choices("Não há mais produtos nesta busca.", [
          { action: "catalog:" + (page - 1), label: "Página anterior" },
          { action: "catalog:0", label: "Início do catálogo" },
          { action: "cart", label: "Ver carrinho" }
        ]);
      }
      say("Não encontrei produtos publicados para essa busca. Tente: buscar bojo ou buscar dublado.");
      return menu();
    }
    state.menuVersion = context.version + 1;
    state.choices = [
      ...result.products.map((product, index) => ({ action: "select:" + product.id, label: `${index + 1}. ${product.title}` })),
      ...result.products.map((product, index) => ({ action: "details:" + product.id, label: "Detalhes " + (index + 1) })),
      ...(page > 0 ? [{ action: "catalog:" + (page - 1), label: "Página anterior" }] : []),
      ...(result.hasMore && page < 1000 ? [{ action: "catalog:" + (page + 1), label: "Mais produtos" }] : []),
      { action: "catalog-options", label: "Mais opções" },
      { action: "cart", label: "Ver carrinho" },
      { action: "menu", label: "Menu" }
    ];
    const hasPagination = page > 0 || result.hasMore;
    // Separate outbox entries keep each photo/button message independently tracked.
    for (const [index, product] of result.products.entries()) {
      replies.push({
        type: "product",
        productId: product.id,
        title: product.title,
        imageUrl: product.imageUrl,
        text: product.title +
        "\nSKU: " +
        product.sku +
        "\n" +
        money(product.priceCents) +
        (settings.unitLabel ? " / " + settings.unitLabel : " (preço cadastrado na loja)") +
        (product.description ? "\n" + product.description.slice(0, 250) : ""),
        options: [
          { id: "v" + state.menuVersion + ":select:" + product.id, label: "Escolher produto" },
          { id: "v" + state.menuVersion + ":details:" + product.id, label: "Ver detalhes" },
          ...(!hasPagination && index === result.products.length - 1
            ? [{ id: "v" + state.menuVersion + ":cart", label: "Ver carrinho" }] : [])
        ]
      });
    }
    if (hasPagination) replies.push({
      type: "choices", text: "Catálogo · página " + (page + 1) + (query ? " · busca: " + query : ""),
      options: state.choices.filter((option) => option.action.startsWith("catalog:") || option.action === "cart")
        .map((option) => ({ id: "v" + state.menuVersion + ":" + option.action, label: option.label }))
    });
  };
  const catalogOptions = () => {
    const navigation = state.choices?.filter((option) => option.action.startsWith("catalog:")) ?? [];
    choices("Opções do catálogo:", [
      ...navigation,
      ...(!navigation.some((option) => option.action === "catalog:" + (state.page ?? 0))
        ? [{ action: "catalog:" + (state.page ?? 0), label: "Voltar ao catálogo" }] : []),
      { action: "cart", label: "Ver carrinho" },
      { action: "menu", label: "Menu" }
    ]);
  };
  const showOrder = async (orderId: string) => {
    if (!customerId) return link();
    const order = await api.order(customerId, orderId);
    if (!order) {
      say("Pedido não encontrado na sua conta.");
      return menu();
    }
    state.orderId = order.id;
    state.phase = "payment";
    say(
      "Pedido #" +
        order.id.slice(0, 8) +
        "\n" +
        (statuses[order.status] ?? "Status: " + order.status) +
        "\nTotal: " +
        money(order.totalCents) +
        (order.status === "awaiting_balance_approval"
          ? "\nA continuidade depende de aprovação da Pontalti. O pedido está bloqueado para produção e envio."
          : order.status === "balance_approved" ? "\nDívida deste pedido: " + money(order.balanceDebtCents ?? 0) : "") +
        (order.delivery ? "\n" + order.delivery : "")
    );
    const options = [
      ...(order.balanceNeedsReview ? [{ action: "balance-order-review:" + order.id, label: "Revisar novo saldo" }] : []),
      { action: "order:" + order.id, label: "Atualizar status" },
      { action: "repeat:" + order.id, label: "Repetir este pedido" },
      { action: "orders", label: "Meus pedidos" },
      { action: "faq", label: "Dúvidas" }
    ];
    if (order.balanceNeedsReview) say("Seu saldo mudou desde a confirmação. Revise o saldo e a dívida prevista para autorizar novamente. Nenhuma dívida foi efetivada por este pedido.");
    if (order.status === "awaiting_payment") {
      if (!order.payment)
        say(
          "Seu pedido está registrado. A geração do pagamento ainda está em processamento; você poderá consultar a mesma cobrança por aqui."
        );
      else {
        say(
          "Cobrança Cora" +
            (order.payment.dueDate ? " · vencimento " + order.payment.dueDate.split("-").reverse().join("/") : "")
        );
        if (order.payment.pix) options.unshift({ action: "pix:" + order.id, label: "Pix copia-e-cola" });
        if (order.payment.boleto) options.unshift({ action: "boleto:" + order.id, label: "Abrir boleto" });
      }
      if (!order.payment?.pix) say("O Pix desta cobrança ainda não está disponível. Consulte novamente em instantes.");
      say("Pagamento também disponível na sua conta: " + api.accountUrl("/checkout/pagamento/" + order.id));
    }
    choices("Escolha uma opção:", options);
  };
  const listOrders = async (page = 0) => {
    if (!customerId) return link();
    const result = await api.orders(customerId, { page });
    const orders = result.slice(0, 8);
    state.phase = "orders";
    if (!orders.length) {
      say(page ? "Não há mais pedidos nesta página. Escreva pedidos para voltar ao início." : "Sua conta ainda não tem pedidos.");
      return menu();
    }
    choices(
      "Seus pedidos mais recentes:\n\n" + orders.map((order) =>
        "#" + order.id.slice(0, 8) + " · " + (statuses[order.status] ?? order.status) + " · " + money(order.totalCents)
      ).join("\n") + "\n\nSelecione um pedido para consultar o status atualizado e as opções de pagamento.",
      [...orders.map((order) => ({
        action: "order:" + order.id,
        label:
          "#" +
          order.id.slice(0, 8) +
          " · " +
          (statuses[order.status] ?? order.status) +
          " · " +
          money(order.totalCents)
      })),
      ...(page > 0 ? [{ action: "orders:" + (page - 1), label: "Página anterior" }] : []),
      ...(result.length > 8 ? [{ action: "orders:" + (page + 1), label: "Mais pedidos" }] : []),
      ...(orders.length < 8 ? [{ action: "repeat:last", label: "Repetir último pedido" }] : []),
      ...(orders.length + (page > 0 ? 1 : 0) + (result.length > 8 ? 1 : 0) < 10
        ? [{ action: "menu", label: "Menu" }] : [])].slice(0, 10)
    );
  };
  const showRepeat = async (orderId: string) => {
    if (!customerId) return link();
    state.repeat = undefined;
    state.preview = undefined;
    const lines = await api.repeatPreview(customerId, orderId);
    if (!lines?.length) {
      say("Não há itens disponíveis para repetir esse pedido na sua conta.");
      return listOrders();
    }
    state.phase = "repeat";
    const available = lines.every((line) => line.available && line.quantity > 0 && line.quantity <= 999);
    if (available) state.repeat = { orderId, lines };
    choices("Repetir pedido #" + orderId.slice(0, 8) + "\n" + lines.map((line) =>
      `${line.quantity} × ${line.title} — ${line.available ? money(line.quantity * line.priceCents) : "indisponível"}`
    ).join("\n") + (available
      ? "\nSubtotal dos itens aos preços atuais: " + money(lines.reduce((sum, line) => sum + line.quantity * line.priceCents, 0)) +
        "\nOs itens serão somados ao seu carrinho. Você poderá revisar quantidades, endereço e entrega antes de confirmar uma nova compra."
      : "\nAlguns itens não podem ser repetidos. Seu carrinho foi preservado; escolha os produtos disponíveis no catálogo."), [
      ...(available ? [{ action: "repeat-confirm", label: "Adicionar ao carrinho" }] : []),
      { action: "cart", label: "Ver carrinho" },
      { action: "catalog:0", label: "Ver produtos" }
    ]);
  };
  const listPixPayments = async (page = 0) => {
    if (!customerId) return link();
    const result = await api.orders(customerId, { page, awaitingPayment: true });
    const orders = result.filter((order) => order.status === "awaiting_payment").slice(0, 8);
    state.phase = "orders";
    if (!orders.length) {
      say(page ? "Não há mais pagamentos nesta página." : "Não há pagamentos pendentes na sua conta.");
      return listOrders();
    }
    choices("Selecione o pedido para consultar a cobrança Cora e receber o Pix copia e cola:", [
      ...orders.map((order) => ({ action: "pix:" + order.id,
        label: "#" + order.id.slice(0, 8) + " · " + money(order.totalCents) })),
      ...(page > 0 ? [{ action: "payments:" + (page - 1), label: "Página anterior" }] : []),
      ...(result.length > 8 ? [{ action: "payments:" + (page + 1), label: "Mais pagamentos" }] : []),
      { action: "orders", label: "Meus pedidos" },
      { action: "menu", label: "Menu" }
    ].slice(0, 10));
  };
  const checkout = async () => {
    if (!customerId) return link();
    if (!(await api.profileComplete(customerId))) {
      state.phase = "cart";
      state.preview = undefined;
      choices(
        "Sua conta já está vinculada, mas o cadastro precisa de nome e CPF válidos para gerar o pagamento.\n" +
          "Complete os dados no site. Seu carrinho fica salvo. Não envie CPF ou senha nesta conversa.\n" +
          api.accountUrl("/conta/perfil") +
          "\n\nDepois de salvar, toque em Retomar compra.",
        [
          { action: "checkout", label: "Retomar compra" },
          { action: "cart", label: "Ver carrinho" }
        ]
      );
      return;
    }
    if (!settings.unitLabel || !settings.delivery.enabled || !settings.delivery.description) {
      say(
        "As condições de venda pelo WhatsApp ainda não estão disponíveis. Seu carrinho fica salvo e você pode continuar consultando produtos e pedidos."
      );
      return;
    }
    const cart = await readCart();
    if (!cart.items.length || cart.items.some((item) => !item.available)) return showCart();
    const addresses = await api.addresses(customerId);
    state.phase = "address";
    if (!addresses.length) {
      choices("Você precisa cadastrar um endereço antes de comprar. Depois de salvar, escreva comprar para retomar.", [
        { action: "account:new", label: "Cadastrar endereço" },
        { action: "cart", label: "Ver carrinho" }
      ]);
      return;
    }
    choices("Selecione um endereço da sua conta:", [
      ...addresses.map((address) => ({ action: "address:" + address.id, label: address.label })),
      { action: "cart", label: "Voltar ao carrinho" }
    ]);
  };
  const reviewAddress = async (addressId: string) => {
    if (!customerId) return link();
    const address = (await api.addresses(customerId)).find((item) => item.id === addressId);
    if (!address) {
      say("Selecione um endereço da sua conta.");
      return checkout();
    }
    const delivery = settings.delivery;
    if (delivery.states.length && !delivery.states.includes(address.state)) {
      say("A modalidade disponível não atende esse endereço. Escolha outro endereço.");
      return checkout();
    }
    const cart = await readCart();
    if (!cart.items.length || cart.items.some((item) => !item.available)) return showCart();
    state.phase = "confirm";
    state.preview = {
      addressId,
      cartVersion: cart.version,
      subtotalCents: cart.subtotalCents,
      feeCents: delivery.feeCents,
      delivery: delivery.description
    };
    say(
      "Resumo final\n" +
        cart.items
          .map((item) => item.quantity + " × " + item.title + " — " + money(item.quantity * item.priceCents))
          .join("\n") +
        "\nEndereço: " +
        address.label +
        "\n" +
        delivery.description +
        "\nCusto da modalidade: " +
        money(delivery.feeCents) +
        "\nTotal: " +
        money(cart.subtotalCents + delivery.feeCents)
    );
    choices("Escolha como deseja pagar este pedido:", [
      { action: "confirm", label: "Pix ou boleto Cora" },
      { action: "balance-review", label: "Saldo na conta" },
      { action: "cart", label: "Voltar ao carrinho" }
    ]);
  };
  const faq = async () => {
    const articles = await api.articles();
    state.phase = "faq";
    choices("Dúvidas sobre a loja:", [
      ...articles.map((article) => ({ action: "article:" + article.id, label: article.title })),
      { action: "delivery", label: "Entrega e condições" },
      { action: "menu", label: "Menu" }
    ]);
  };
  const applyQuantity = async (quantity: number) => {
    const productId = state.productId;
    if (
      !productId ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > 999 ||
      (quantity === 0 && state.quantityMode !== "set")
    ) {
      say("Informe uma quantidade de 1 a 999; para remover um item em edição, informe 0.");
      return;
    }
    if (customerId) {
      try {
        await api.mutateCart(
          customerId,
          [{ productId, quantity }],
          state.quantityMode ?? "increment",
          context.eventId + ":quantity"
        );
      } catch (error) {
        if (!(error instanceof CustomerActionError)) throw error;
        say(error.message);
        return showCart();
      }
    } else {
      const pending = new Map((state.pending ?? []).map((item) => [item.productId, item.quantity]));
      const next = state.quantityMode === "set" ? quantity : Math.min(999, (pending.get(productId) ?? 0) + quantity);
      if (next) pending.set(productId, next);
      else pending.delete(productId);
      state.pending = Array.from(pending, ([id, qty]) => ({ productId: id, quantity: qty }));
    }
    state.productId = undefined;
    say(quantity === 0 ? "Item removido." : "Carrinho atualizado.");
    return showCart();
  };
  const chooseProduct = async (productId: string, mode: "increment" | "set") => {
    const product = (await api.products([productId]))[0];
    if (!product && mode !== "set") {
      say("Esse produto não está mais publicado.");
      return catalog(0);
    }
    state.phase = "quantity";
    state.productId = productId;
    state.quantityMode = mode;
    choices(
      (product?.title ?? "Item do carrinho") +
        "\nQual quantidade deseja? Escolha abaixo ou digite de 1 a 999" +
        (settings.unitLabel ? " em " + settings.unitLabel : "") +
        (mode === "set" ? ". Digite 0 para remover." : "."),
      [
        { action: "quantity:1", label: "1 unidade" },
        { action: "quantity:2", label: "2 unidades" },
        { action: "catalog:0", label: "Voltar ao catálogo" }
      ]
    );
  };
  const productDetails = async (productId: string) => {
    const product = (await api.products([productId]))[0];
    if (!product) {
      say("Esse produto não está mais publicado.");
      return catalog(0);
    }
    choices(
      product.title + "\nSKU: " + product.sku + "\n" + money(product.priceCents) +
      (settings.unitLabel ? " / " + settings.unitLabel : "") + "\n\n" +
      (product.description ?? "Consulte as informações publicadas na loja."),
      [
        { action: "select:" + product.id, label: "Escolher produto" },
        { action: "catalog:" + (state.page ?? 0), label: "Voltar ao catálogo" },
        { action: "cart", label: "Ver carrinho" }
      ]
    );
  };
  const run = async (action: string) => {
    if (isFinanceAction(action)) return financeAction(action, finance());
    const [command, ...parts] = action.split(":");
    const value = parts.join(":");
    switch (command) {
      case "menu":
        return menu();
      case "catalog":
        return catalog(Number(value) || 0);
      case "catalog-options":
        return catalogOptions();
      case "cart":
        return showCart();
      case "select":
        return chooseProduct(value, "increment");
      case "details":
        return productDetails(value);
      case "quantity":
        if (state.phase === "quantity") return applyQuantity(Number(value));
        return showCart();
      case "edit":
        return chooseProduct(value, "set");
      case "checkout":
        return checkout();
      case "address":
        return reviewAddress(value);
      case "orders":
        return listOrders(Math.max(0, Math.min(1000, Number(value) || 0)));
      case "payments":
        return listPixPayments(Math.max(0, Math.min(1000, Number(value) || 0)));
      case "account":
        if (!customerId) return link();
        return accountAction(value, account());
      case "repeat": {
        if (!customerId) return link();
        const id = value === "last" ? (await api.orders(customerId))[0]?.id : value;
        if (!id) {
          say("Sua conta ainda não tem pedidos para repetir.");
          return menu();
        }
        return showRepeat(id);
      }
      case "repeat-confirm": {
        if (!customerId || state.phase !== "repeat" || !state.repeat) return showCart();
        const repeat = state.repeat;
        try {
          await api.repeatOrder(customerId, context.contactId, repeat.orderId, repeat.lines, context.eventId + ":repeat");
        } catch (error) {
          if (!(error instanceof CustomerActionError)) throw error;
          say(error.message);
          return showRepeat(repeat.orderId);
        }
        state.repeat = undefined;
        say("Itens adicionados ao carrinho aos preços atuais. Revise antes de continuar a compra.");
        return showCart();
      }
      case "order":
        return showOrder(value);
      case "faq":
        return faq();
      case "clear":
        if (customerId) await api.mutateCart(customerId, [], "clear", context.eventId + ":clear");
        else state.pending = [];
        return showCart();
      case "merge":
        if (customerId && value === "yes") {
          try {
            await api.mutateCart(customerId, state.pending ?? [], "increment", context.eventId + ":merge");
          } catch (error) {
            if (!(error instanceof CustomerActionError)) throw error;
            say(error.message);
            choices("Você pode selecionar outros produtos ou usar somente o carrinho da sua conta.", [
              { action: "catalog:0", label: "Ver produtos" },
              { action: "merge:no", label: "Usar somente o carrinho da loja" }
            ]);
            return;
          }
        }
        state.pending = [];
        return showCart();
      case "confirm": {
        if (!customerId || !state.preview || state.phase !== "confirm") return showCart();
        try {
          const result = await api.checkout(customerId, state.preview, context.conversationId);
          state.preview = undefined;
          state.orderId = result.orderId;
          say("Pedido #" + result.orderId.slice(0, 8) + " registrado.");
          return showOrder(result.orderId);
        } catch (error) {
          say(error instanceof Error ? error.message : "Revise seu carrinho antes de confirmar.");
          return showCart();
        }
      }
      case "pix":
      case "boleto": {
        if (!customerId) return link();
        const order = await api.order(customerId, value);
        if (!order || order.status !== "awaiting_payment") return showOrder(value);
        if (command === "pix") {
          const pix = order.payment?.pix;
          if (pix) {
            const qr = await QRCode.toDataURL(pix, { type: "image/png", width: 640, margin: 4, errorCorrectionLevel: "M" });
            say("Pix do pedido #" + order.id.slice(0, 8) + " · " + money(order.totalCents) +
              "\nCopie a mensagem seguinte inteira para pagar com Pix no aplicativo do seu banco. Você também pode escanear o QR Code enviado logo depois.", true);
            const code: BotMessage = { type: "text", text: pix, literal: true };
            standalone.add(code);
            replies.push(code, {
              type: "image", url: qr,
              caption: "QR Code Pix · pedido #" + order.id.slice(0, 8) + " · " + money(order.totalCents)
            });
          } else say("Pix ainda não disponível. Consulte o pagamento novamente.", true);
        }
        else if (order.payment?.boleto) {
          replies.push({
            type: "document",
            url: order.payment.boleto,
            filename: "boleto-pontalti-" + order.id.slice(0, 8) + ".pdf",
            caption: "Boleto Cora · pedido #" + order.id.slice(0, 8) +
              (order.payment.digitable ? "\nLinha digitável: " + order.payment.digitable : "")
          });
        } else say("Boleto ainda não disponível.");
        return showOrder(value);
      }
      case "article": {
        const article = (await api.articles()).find((item) => item.id === value);
        say(article?.answer ?? "Essa orientação não está disponível.");
        return faq();
      }
      case "delivery":
        say(
          settings.delivery.enabled && settings.delivery.description
            ? settings.delivery.description + "\nCusto: " + money(settings.delivery.feeCents)
            : "As condições de entrega pelo WhatsApp ainda não estão cadastradas. O bot apresenta somente informações publicadas pela loja."
        );
        return faq();
      default:
        return menu();
    }
  };

  const text = clean(context.text);
  if (text === "desvincular") {
    await api.unlink(context.contactId);
    state.customerId = null;
    state.pending = [];
    state.preview = undefined;
    state.accountEdit = undefined;
    state.repeat = undefined;
    state.balanceQuote = undefined;
    state.depositInput = undefined;
    customerId = null;
    say("Conta desvinculada desta conversa.");
    menu();
  } else if (/^vincular\s+\d{6}$/.test(text)) {
    customerId = await api.confirmLink(context.contactId, text.split(/\s+/)[1], context.eventId);
    if (!customerId) say("Código inválido ou expirado. Solicite um novo link escrevendo conta.");
    else {
      state.customerId = customerId;
      state.preview = undefined;
      say("Conta vinculada. Você pode acessar seu carrinho e seus pedidos.");
      if (state.pending?.length) {
        state.phase = "merge";
        choices("Deseja adicionar os produtos escolhidos nesta conversa ao carrinho da sua conta?", [
          { action: "merge:yes", label: "Adicionar ao carrinho da loja" },
          { action: "merge:no", label: "Usar somente o carrinho da loja" }
        ]);
      } else menu();
    }
  } else if (text === "conta") {
    if (customerId) await showAccount(account());
    else await link();
  } else if (text.startsWith("buscar ")) await catalog(0, context.text.trim().slice(7, 100));
  else if (["produtos", "catalogo", "ver produtos"].includes(text)) {
    state.query = "";
    await catalog(0, "");
  } else if (["carrinho", "ver carrinho"].includes(text)) await showCart();
  else if (["comprar", "checkout", "continuar compra"].includes(text)) await checkout();
  else if (["pedido", "pedidos", "meus pedidos", "acompanhar", "status", "status do pedido", "consultar pedido"].includes(text)) await listOrders();
  else if (["repetir", "repetir pedido", "repetir ultimo pedido"].includes(text)) await run("repeat:last");
  else if (["meus dados", "cadastro", "perfil", "alterar cadastro"].includes(text)) {
    if (customerId) await showAccount(account());
    else await link();
  } else if (["endereco", "enderecos", "meus enderecos", "alterar endereco"].includes(text)) await run("account:addresses");
  else if (["pix", "pagar", "pagamento", "pagar com pix"].includes(text)) await listPixPayments();
  else if (["saldo", "meu saldo", "saldo na conta"].includes(text)) await financeAction("balance", finance());
  else if (["extrato", "extrato do saldo"].includes(text)) await financeAction("balance-statement", finance());
  else if (["adicionar saldo", "depositar"].includes(text)) await financeAction("deposit-new", finance());
  else if (["ja depositei", "fiz um deposito", "depositei"].includes(text)) await financeAction("deposit-claim", finance());
  else if (["depositos", "meus depositos"].includes(text)) await financeAction("deposits", finance());
  else if (["duvidas", "ajuda", "suporte"].includes(text)) await faq();
  else if (text === "menu") menu();
  else if (customerId && state.phase === "finance_input" && !/^v\d+:/.test(context.text) &&
    !state.choices?.some((option) => clean(option.label) === text)) await financeInput(context.text, finance());
  else if (customerId && state.phase === "account_input" && !/^v\d+:/.test(context.text)) {
    if (["cancelar", "cancelar alteracao"].includes(text)) await showAccount(account());
    else await accountInput(context.text, account());
  }
  else if (state.phase === "quantity" && /^\d{1,3}$/.test(text)) await applyQuantity(Number(text));
  else if (state.phase === "catalog" && ["opcoes", "mais opcoes"].includes(text)) catalogOptions();
  else if (state.phase === "catalog" && /^detalhes(?:\s+\d+)?$/.test(text)) {
    const productId = state.catalogIds?.[Number(text.split(/\s+/)[1] ?? 1) - 1];
    if (productId) await productDetails(productId);
    else say("Escolha um produto da página atual.");
  } else {
    let action: string | undefined;
    if (/^v\d+:/.test(context.text)) {
      const prefix = "v" + state.menuVersion + ":";
      if (context.text.startsWith(prefix))
        action = state.choices?.find((choice) => choice.action === context.text.slice(prefix.length))?.action;
      if (!action) say("Essa opção pertence a um menu anterior. Use o menu mais recente ou escreva menu.");
    } else if (/^\d+$/.test(text)) action = state.choices?.[Number(text) - 1]?.action;
    else action = state.choices?.find((choice) => clean(choice.label) === text)?.action;
    if (action) await run(action);
    else if (!/^v\d+:/.test(context.text)) {
      say(
        "Posso ajudar com os produtos publicados, pagamentos, pedidos e dúvidas disponíveis. Escolha uma opção ou escreva buscar seguido do produto."
      );
      menu();
    }
  }
  return { state, replies: replies.map((reply) => (customerId ? { ...reply, customerId } : reply)) };
}
