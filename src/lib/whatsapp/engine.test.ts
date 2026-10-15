import { test } from "node:test";
import assert from "node:assert/strict";
import { processConversation } from "./engine";
import type { BotContext, BotServices, BotState } from "./types";
import { CustomerActionError } from "./types";

const product = {
  id: "product",
  title: "Bojo",
  sku: "TEST",
  description: null,
  priceCents: 1000,
  imageUrl: null,
  url: "https://test/produtos/product"
};
function fixture() {
  let mutations = 0;
  let checkouts = 0;
  let lastBuyer = "";
  const profileUpdates: unknown[] = [];
  const addressUpdates: unknown[] = [];
  let repeats = 0;
  const api: BotServices = {
    settings: async () => ({
      unitLabel: "unidade",
      delivery: { enabled: true, description: "Retirada", feeCents: 0, states: ["SP"] }
    }),
    catalog: async () => ({ products: [product], hasMore: false }),
    products: async () => [product],
    cart: async () => ({
      version: 3,
      items: [{ productId: "product", quantity: 2, title: "Bojo", priceCents: 1000, available: true }],
      subtotalCents: 2000
    }),
    mutateCart: async () => {
      mutations++;
    },
    profileComplete: async () => true,
    profile: async () => ({ fullName: "Cliente de teste", phone: "11999990000" }),
    updateProfile: async (...input) => { profileUpdates.push(input); },
    saveAddress: async (...input) => { addressUpdates.push(input); },
    repeatPreview: async () => [{ productId: product.id, quantity: 2, title: product.title, priceCents: 1200, available: true }],
    repeatOrder: async () => { repeats++; },
    addresses: async () => [{ id: "address", label: "Endereço de teste", state: "SP" }],
    orders: async (buyer) => {
      lastBuyer = buyer;
      return [];
    },
    order: async () => null,
    checkout: async () => {
      checkouts++;
      return { orderId: "order", status: "ready" };
    },
    createLink: async () => "https://test/link",
    confirmLink: async () => "buyer",
    unlink: async () => {},
    articles: async () => [{ id: "payment", title: "Como pagar?", answer: "Pix e boleto Cora." }],
    accountUrl: (path) => "https://test" + path
  };
  return { api, stats: () => ({ mutations, checkouts, lastBuyer, profileUpdates, addressUpdates, repeats }) };
}
const context = (text: string, customerId: string | null = null): BotContext => ({
  eventId: "event",
  conversationId: "conversation",
  contactId: "contact",
  customerId,
  version: 2,
  text
});
test("catálogo envia uma mensagem de foto e botões para cada produto da página", async () => {
  const f = fixture();
  f.api.catalog = async () => ({ products: [product, { ...product, id: "other", title: "Dublado" }], hasMore: false });
  const result = await processConversation(context("produtos"), {}, f.api);
  assert.equal(result.replies.length, 2);
  const first = result.replies[0];
  const second = result.replies[1];
  if (first.type !== "product" || second.type !== "product") throw new Error("Expected individual products");
  assert.equal(first.productId, "product");
  assert.equal(second.productId, "other");
  assert.equal(first.options[0].id, "v3:select:product");
  assert.equal(first.options[1].id, "v3:details:product");
  assert.equal(second.options[0].id, "v3:select:other");
  assert.equal(second.options[1].id, "v3:details:other");
  assert.equal(second.options[2].id, "v3:cart");
  assert.deepEqual(result.state.catalogIds, ["product", "other"]);
  assert.doesNotMatch(JSON.stringify(result.replies), /wa\.me|detalhes seguido/);
  const selected = await processConversation(context(first.options[0].id), result.state, f.api);
  assert.equal(selected.state.phase, "quantity");
  const quantity = selected.replies[0];
  assert.equal(quantity.type, "choices");
  if (quantity.type !== "choices") throw new Error("Expected quantity choices");
  assert.equal(quantity.options[1].label, "2 unidades");
  const added = await processConversation(context(quantity.options[1].id), selected.state, f.api);
  assert.deepEqual(added.state.pending, [{ productId: "product", quantity: 2 }]);
  assert.equal(added.replies.length, 1);
  assert.equal(added.replies[0].type, "choices");
});
test("botão na segunda foto seleciona somente esse produto", async () => {
  const f = fixture();
  const second = { ...product, id: "other", title: "Dublado" };
  f.api.catalog = async () => ({ products: [product, second], hasMore: false });
  f.api.products = async (ids) => [product, second].filter((item) => ids.includes(item.id));
  const result = await processConversation(context("produtos", "buyer"), {}, f.api);
  const photo = result.replies[1];
  if (photo.type !== "product") throw new Error("Expected second product photo");
  const selected = await processConversation({ ...context(photo.options[0].id, "buyer"), version: 3 }, result.state, f.api);
  assert.equal(selected.state.productId, "other");
  assert.equal(selected.state.phase, "quantity");
  assert.match(JSON.stringify(selected.replies), /Dublado/);
  assert.equal(f.stats().mutations, 0);
});
test("paginação de fotos individuais preserva busca, IDs e carrinho; menus antigos são recusados", async () => {
  const f = fixture();
  const products = Array.from({ length: 7 }, (_, index) => ({ ...product,
    id: "product-" + index, title: "Bojo " + index, imageUrl: "https://test/photo-" + index + ".png" }));
  const reads: { query: string; page: number }[] = [];
  f.api.catalog = async (query, page) => {
    reads.push({ query, page });
    return { products: products.slice(page * 3, page * 3 + 3), hasMore: page < 2 };
  };
  const first = await processConversation(context("buscar bojo", "buyer"), {}, f.api);
  const next = await processConversation({ ...context("v3:catalog:1", "buyer"), version: 3 }, first.state, f.api);
  const card = next.replies[0];
  assert.equal(next.replies.length, 4);
  if (card.type !== "product") throw new Error("Expected product photo");
  assert.equal(card.productId, "product-3");
  assert.equal(card.imageUrl, products[3].imageUrl);
  assert.deepEqual(card.options.map((option) => option.id), ["v4:select:product-3", "v4:details:product-3"]);
  const navigation = next.replies[3];
  if (navigation.type !== "choices") throw new Error("Expected page navigation");
  assert.deepEqual(navigation.options.map((option) => option.id), ["v4:catalog:0", "v4:catalog:2", "v4:cart"]);
  const stale = await processConversation(context("v3:select:product-0", "buyer"), next.state, f.api);
  assert.match(JSON.stringify(stale.replies), /menu anterior/);
  assert.equal(stale.state.phase, "catalog");
  const last = await processConversation({ ...context("v4:catalog:2", "buyer"), version: 4 }, next.state, f.api);
  if (last.replies[0].type !== "product") throw new Error("Expected final product");
  assert.equal(last.replies[0].productId, "product-6");
  assert.ok(!last.state.choices?.some((option) => option.action === "catalog:3"));
  const back = await processConversation({ ...context("v5:catalog:1", "buyer"), version: 5 }, last.state, f.api);
  assert.equal(back.state.page, 1);
  assert.deepEqual(back.state.catalogIds, products.slice(3, 6).map((p) => p.id));
  assert.deepEqual(reads, [0, 1, 2, 1].map((page) => ({ query: "bojo", page })));
  const options = await processConversation({ ...context("opções", "buyer"), version: 6 }, back.state, f.api);
  if (options.replies[0].type !== "choices") throw new Error("Expected product actions");
  assert.ok(options.replies[0].options.some((option) => option.id === "v7:catalog:1"));
  assert.ok(options.replies[0].options.some((option) => option.id === "v7:catalog:0"));
  assert.ok(options.replies[0].options.some((option) => option.id === "v7:catalog:2"));
  assert.equal(f.stats().mutations, 0);
  assert.equal(f.stats().checkouts, 0);
});
test("fim de catálogo após remoção de produto oferece retorno sem perder a busca", async () => {
  const f = fixture();
  f.api.catalog = async () => ({ products: [], hasMore: false });
  const result = await processConversation(context("v3:catalog:2", "buyer"), {
    customerId: "buyer", phase: "catalog", page: 1, query: "bojo", menuVersion: 3,
    choices: [{ action: "catalog:2", label: "Próximo" }]
  }, f.api);
  assert.equal(result.state.query, "bojo");
  if (result.replies[0].type !== "choices") throw new Error("Expected return actions");
  assert.equal(result.replies[0].options[0].id, "v3:catalog:1");
  assert.match(result.replies[0].text, /Não há mais produtos/);
});
test("botão de detalhes não adiciona produto ao carrinho", async () => {
  const f = fixture();
  const catalog = await processConversation(context("produtos", "buyer"), {}, f.api);
  const details = await processConversation(context("v3:details:product", "buyer"), catalog.state, f.api);
  assert.match(JSON.stringify(details.replies), /SKU: TEST/);
  assert.equal(f.stats().mutations, 0);
  assert.equal(details.replies.length, 1);
});
test("boleto escolhido é enviado como PDF do pedido verificado", async () => {
  const f = fixture();
  f.api.order = async (customerId, id) => {
    assert.equal(customerId, "buyer");
    assert.equal(id, "order");
    return {
      id, status: "awaiting_payment", totalCents: 2000, delivery: "Retirada",
      payment: { status: "open", pix: null, boleto: "https://test/boleto.pdf", digitable: "123", dueDate: "2026-10-10" }
    };
  };
  const result = await processConversation(context("v3:boleto:order", "buyer"), {
    customerId: "buyer", phase: "payment", menuVersion: 3, choices: [{ action: "boleto:order", label: "Abrir boleto" }]
  }, f.api);
  assert.equal(result.replies[0].type, "document");
  if (result.replies[0].type !== "document") throw new Error("Expected PDF");
  assert.equal(result.replies[0].url, "https://test/boleto.pdf");
});
test("cliente sem vínculo escolhe produto e guarda seleção sem tocar em conta", async () => {
  const f = fixture();
  const result = await processConversation(
    context("2"),
    { phase: "quantity", productId: "product", quantityMode: "increment" },
    f.api
  );
  assert.deepEqual(result.state.pending, [{ productId: "product", quantity: 2 }]);
  assert.equal(f.stats().mutations, 0);
  const checkout = await processConversation(context("comprar"), result.state, f.api);
  assert.match(JSON.stringify(checkout.replies), /link seguro/);
  assert.match(JSON.stringify(checkout.replies), /Cadastre-se no site/);
  assert.match(JSON.stringify(checkout.replies), /Não envie CPF ou senha/);
  assert.deepEqual(checkout.state.pending, result.state.pending);
  assert.equal(f.stats().checkouts, 0);
});
test("cadastro incompleto preserva carrinho e permite retomar a compra após correção no site", async () => {
  const f = fixture();
  let complete = false;
  f.api.profileComplete = async (buyer) => {
    assert.equal(buyer, "buyer");
    return complete;
  };
  const blocked = await processConversation(context("comprar", "buyer"), {
    customerId: "buyer",
    phase: "confirm",
    preview: { addressId: "address", cartVersion: 3, subtotalCents: 2000, feeCents: 0, delivery: "Retirada" }
  }, f.api);
  assert.equal(blocked.state.phase, "cart");
  assert.equal(blocked.state.preview, undefined);
  assert.equal(blocked.replies.length, 1);
  const reply = blocked.replies[0];
  if (reply.type !== "choices") throw new Error("Expected profile recovery choices");
  assert.match(reply.text, /https:\/\/test\/conta\/perfil/);
  assert.match(reply.text, /carrinho fica salvo/);
  assert.match(reply.text, /Não envie CPF/);
  assert.equal(reply.options[0].label, "Retomar compra");
  assert.equal(f.stats().checkouts, 0);
  assert.equal(f.stats().mutations, 0);
  complete = true;
  const resumed = await processConversation({ ...context(reply.options[0].id, "buyer"), version: 3 }, blocked.state, f.api);
  assert.equal(resumed.state.phase, "address");
  assert.match(JSON.stringify(resumed.replies), /Endereço de teste/);
  assert.equal(f.stats().checkouts, 0);
  assert.equal(f.stats().mutations, 0);
});
test("pedidos exigem vínculo e usam somente a identidade verificada", async () => {
  const f = fixture();
  await processConversation(context("pedidos"), {}, f.api);
  assert.equal(f.stats().lastBuyer, "");
  await processConversation(context("pedidos", "buyer"), {}, f.api);
  assert.equal(f.stats().lastBuyer, "buyer");
});
test("resposta a menu antigo não altera carrinho", async () => {
  const f = fixture();
  const state: BotState = { customerId: "buyer", menuVersion: 3, choices: [{ action: "clear", label: "Esvaziar" }] };
  const result = await processConversation(context("v1:clear", "buyer"), state, f.api);
  assert.equal(f.stats().mutations, 0);
  assert.match(JSON.stringify(result.replies), /menu anterior/);
});
test("vínculo pede escolha explícita antes de mesclar seleção provisória", async () => {
  const f = fixture();
  const result = await processConversation(
    context("vincular 123456"),
    { pending: [{ productId: "product", quantity: 2 }] },
    f.api
  );
  assert.equal(result.state.phase, "merge");
  assert.equal(f.stats().mutations, 0);
  assert.equal(
    result.replies.every((reply) => reply.customerId === "buyer"),
    true
  );
});
test("configuração comercial incompleta preserva carrinho e não cobra", async () => {
  const f = fixture();
  f.api.settings = async () => ({
    unitLabel: "",
    delivery: { enabled: false, description: "", feeCents: 0, states: [] }
  });
  const result = await processConversation(context("comprar", "buyer"), {}, f.api);
  assert.match(JSON.stringify(result.replies), /carrinho fica salvo/);
  assert.equal(f.stats().checkouts, 0);
});
test("suporte responde com conteúdo aprovado sem transferência humana", async () => {
  const f = fixture();
  const result = await processConversation(context("ajuda"), {}, f.api);
  assert.match(JSON.stringify(result.replies), /Como pagar/);
  assert.doesNotMatch(JSON.stringify(result.replies), /equipe|atendente/i);
});
test("produto ocultado depois da seleção responde sem cobrar ou perder a conversa", async () => {
  const f = fixture();
  f.api.mutateCart = async () => {
    throw new CustomerActionError("Produto indisponível.");
  };
  const result = await processConversation(
    context("2", "buyer"),
    {
      customerId: "buyer",
      phase: "quantity",
      productId: "product",
      quantityMode: "increment"
    },
    f.api
  );
  assert.match(JSON.stringify(result.replies), /Produto indisponível/);
  assert.equal(result.state.phase, "cart");
  assert.equal(f.stats().checkouts, 0);
});

const pendingOrder = {
  id: "order", status: "awaiting_payment", totalCents: 2400, delivery: "Retirada",
  payment: { status: "open", pix: "000201-PIX-CORA", boleto: null, digitable: null, dueDate: "2026-10-20" }
};
async function click(f: ReturnType<typeof fixture>, state: BotState, action: string) {
  assert.ok(state.choices?.some((choice) => choice.action === action), "Ação disponível: " + action);
  return processConversation({ ...context(`v${state.menuVersion}:${action}`, "buyer"), version: state.menuVersion ?? 0 }, state, f.api);
}
test("menu oferece pedidos, cadastro, repetição e Pix", async () => {
  const f = fixture();
  const result = await processConversation(context("menu", "buyer"), {}, f.api);
  for (const action of ["orders", "account:home", "repeat:last", "payments"])
    assert.ok(result.state.choices?.some((choice) => choice.action === action));
});
test("status consulta o pedido da conta e permite atualizar sua situação", async () => {
  const f = fixture();
  f.api.orders = async () => [{ ...pendingOrder, status: "in_production" }];
  let status = "in_production";
  f.api.order = async (buyer) => {
    assert.equal(buyer, "buyer");
    return { ...pendingOrder, status };
  };
  const list = await processConversation(context("status do pedido", "buyer"), {}, f.api);
  assert.match(JSON.stringify(list.replies), /Em produção/);
  const detail = await click(f, list.state, "order:order");
  status = "shipped";
  const updated = await click(f, detail.state, "order:order");
  assert.match(JSON.stringify(updated.replies), /Enviado/);
  assert.equal(f.stats().checkouts, 0);
});
test("Pix envia o código Cora isolado e não cria outra cobrança", async () => {
  const f = fixture();
  f.api.orders = async () => [pendingOrder];
  f.api.order = async () => pendingOrder;
  const list = await processConversation(context("pix", "buyer"), {}, f.api);
  const result = await click(f, list.state, "pix:order");
  assert.equal(result.replies[0].type, "text");
  assert.match(JSON.stringify(result.replies[0]), /Copie a mensagem seguinte/);
  assert.deepEqual(result.replies[1], { type: "text", text: "000201-PIX-CORA", literal: true, customerId: "buyer" });
  const qr = result.replies[2];
  assert.equal(qr.type, "image");
  if (qr.type !== "image") throw new Error("Expected Pix QR image");
  assert.match(qr.url, /^data:image\/png;base64,/);
  const png = Buffer.from(qr.url.split(",")[1], "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 640);
  assert.equal(f.stats().checkouts, 0);
  f.api.order = async () => ({ ...pendingOrder, status: "paid" });
  const paid = await click(f, result.state, "pix:order");
  assert.doesNotMatch(JSON.stringify(paid.replies), /000201-PIX-CORA/);
  assert.equal(paid.replies.some((reply) => reply.type === "image"), false);
  assert.match(JSON.stringify(paid.replies), /Pagamento confirmado/);
});
test("cadastro exige vínculo e confirma nome antes de salvar somente o campo escolhido", async () => {
  const f = fixture();
  const blocked = await processConversation(context("meus dados"), {}, f.api);
  assert.match(JSON.stringify(blocked.replies), /link seguro/);
  const account = await processConversation(context("meus dados", "buyer"), {}, f.api);
  assert.match(JSON.stringify(account.replies), /Cliente de teste/);
  const edit = await click(f, account.state, "account:name");
  const invalid = await processConversation(context("A", "buyer"), edit.state, f.api);
  assert.equal(invalid.state.phase, "account_input");
  const preview = await processConversation(context("Ana Silva", "buyer"), invalid.state, f.api);
  assert.equal(f.stats().profileUpdates.length, 0);
  await click(f, preview.state, "account:save");
  assert.deepEqual(f.stats().profileUpdates[0], ["buyer", "contact", { fullName: "Ana Silva" }, "event:profile"]);
});
test("telefone valida DDD, permite remoção e cancelamento não salva", async () => {
  const f = fixture();
  const account = await processConversation(context("conta", "buyer"), {}, f.api);
  const edit = await click(f, account.state, "account:phone");
  const invalid = await processConversation(context("123", "buyer"), edit.state, f.api);
  assert.equal(invalid.state.phase, "account_input");
  const preview = await processConversation(context("(11) 98888-7777", "buyer"), invalid.state, f.api);
  await click(f, preview.state, "account:cancel");
  assert.equal(f.stats().profileUpdates.length, 0);
  const remove = await click(f, account.state, "account:phone");
  const confirmation = await processConversation(context("remover", "buyer"), remove.state, f.api);
  await click(f, confirmation.state, "account:save");
  assert.deepEqual(f.stats().profileUpdates[0], ["buyer", "contact", { phone: null }, "event:profile"]);
});
test("endereço novo é coletado e validado na conversa e só persiste após confirmação", async () => {
  const f = fixture();
  const addresses = await processConversation(context("enderecos", "buyer"), {}, f.api);
  let result = await click(f, addresses.state, "account:new");
  result = await processConversation(context("123", "buyer"), result.state, f.api);
  assert.equal(result.state.accountEdit?.kind === "address" && result.state.accountEdit.field, "zipCode");
  for (const value of ["01001-000", "Praça da Sé", "10", "sem complemento", "Sé", "São Paulo", "XX"])
    result = await processConversation(context(value, "buyer"), result.state, f.api);
  assert.equal(result.state.accountEdit?.kind === "address" && result.state.accountEdit.field, "state");
  result = await processConversation(context("sp", "buyer"), result.state, f.api);
  result = await click(f, result.state, "account:default:yes");
  assert.equal(f.stats().addressUpdates.length, 0);
  await click(f, result.state, "account:save");
  assert.deepEqual(f.stats().addressUpdates[0], ["buyer", "contact", {
    zipCode: "01001000", street: "Praça da Sé", number: "10", complement: "", neighborhood: "Sé",
    city: "São Paulo", state: "SP", isDefault: true
  }, undefined, "event:address"]);
});
test("mudança de vínculo descarta rascunho cadastral e ações antigas", async () => {
  const f = fixture();
  const account = await processConversation(context("conta", "buyer"), {}, f.api);
  const edit = await click(f, account.state, "account:name");
  const preview = await processConversation(context("Ana Silva", "buyer"), edit.state, f.api);
  const result = await processConversation(context(`v${preview.state.menuVersion}:account:save`), preview.state, f.api);
  assert.equal(result.state.accountEdit, undefined);
  assert.equal(f.stats().profileUpdates.length, 0);
});
test("endereço existente permite consultar e corrigir um campo antes de salvar", async () => {
  const f = fixture();
  f.api.addresses = async () => [{ id: "address", label: "Rua antiga, 10", state: "SP", details: {
    zipCode: "01001000", street: "Rua antiga", number: "10", complement: "Casa", neighborhood: "Centro",
    city: "São Paulo", state: "SP", isDefault: true
  } }];
  const addresses = await processConversation(context("meus enderecos", "buyer"), {}, f.api);
  const address = await click(f, addresses.state, "account:address:address");
  assert.match(JSON.stringify(address.replies), /Rua antiga/);
  const edit = await click(f, address.state, "account:field:address:number");
  const preview = await processConversation(context("25", "buyer"), edit.state, f.api);
  assert.equal(f.stats().addressUpdates.length, 0);
  await click(f, preview.state, "account:save");
  assert.deepEqual(f.stats().addressUpdates[0], ["buyer", "contact", {
    zipCode: "01001000", street: "Rua antiga", number: "25", complement: "Casa", neighborhood: "Centro",
    city: "São Paulo", state: "SP", isDefault: true
  }, "address", "event:address"]);
});
test("repetir último pedido revisa preços atuais, preserva carrinho e não compra automaticamente", async () => {
  const f = fixture();
  f.api.orders = async () => [pendingOrder];
  const preview = await processConversation(context("repetir ultimo pedido", "buyer"), {}, f.api);
  assert.match(JSON.stringify(preview.replies), /24,00/);
  assert.equal(f.stats().repeats, 0);
  const result = await click(f, preview.state, "repeat-confirm");
  assert.equal(f.stats().repeats, 1);
  assert.equal(f.stats().checkouts, 0);
  assert.equal(result.state.phase, "cart");
  const stale = await processConversation(context(`v${preview.state.menuVersion}:repeat-confirm`, "buyer"), result.state, f.api);
  assert.match(JSON.stringify(stale.replies), /menu anterior/);
  assert.equal(f.stats().repeats, 1);
});
test("item indisponível impede repetição parcial e preço alterado exige nova revisão", async () => {
  const f = fixture();
  f.api.orders = async () => [pendingOrder];
  f.api.repeatPreview = async () => [{ productId: "product", quantity: 2, title: "Bojo", priceCents: 1200, available: false }];
  const blocked = await processConversation(context("repetir pedido", "buyer"), {}, f.api);
  assert.equal(blocked.state.repeat, undefined);
  assert.ok(!blocked.state.choices?.some((choice) => choice.action === "repeat-confirm"));
  f.api.repeatPreview = async () => [{ productId: "product", quantity: 2, title: "Bojo", priceCents: 1200, available: true }];
  const preview = await processConversation(context("repetir pedido", "buyer"), {}, f.api);
  f.api.repeatOrder = async () => { throw new CustomerActionError("O preço mudou."); };
  f.api.repeatPreview = async () => [{ productId: "product", quantity: 2, title: "Bojo", priceCents: 1400, available: true }];
  const changed = await click(f, preview.state, "repeat-confirm");
  assert.match(JSON.stringify(changed.replies), /28,00/);
  assert.equal(f.stats().repeats, 0);
  assert.equal(f.stats().checkouts, 0);
});
