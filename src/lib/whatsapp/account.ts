import { addressSchema, profileSchema, type AddressInput } from "@/lib/validation";
import { CustomerActionError, type BotServices, type BotState } from "./types";

type Flow = {
  api: BotServices;
  state: BotState;
  customerId: string;
  contactId: string;
  eventId: string;
  say(text: string): void;
  choices(text: string, options: { action: string; label: string }[]): void;
};
const fields = ["zipCode", "street", "number", "complement", "neighborhood", "city", "state"] as const;
const labels: Record<keyof AddressInput, string> = {
  zipCode: "CEP", street: "Rua", number: "Número", complement: "Complemento",
  neighborhood: "Bairro", city: "Cidade", state: "Estado (UF)", isDefault: "Endereço padrão"
};
const states = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
const addressText = (input: Partial<AddressInput>) =>
  `${input.street}, ${input.number}${input.complement ? " · " + input.complement : ""}\n` +
  `${input.neighborhood} · ${input.city}/${input.state} · CEP ${input.zipCode}` +
  (input.isDefault ? "\nEndereço padrão" : "");

export async function showAccount(flow: Flow) {
  const { api, state, customerId, choices } = flow;
  state.accountEdit = undefined;
  state.preview = undefined;
  state.phase = "account";
  const profile = await api.profile(customerId);
  choices(`Meus dados\nNome: ${profile.fullName}\nTelefone: ${profile.phone || "Não informado"}\n\n` +
    "Alterar o telefone de contato não altera o vínculo desta conversa. Para CPF e acesso à conta, use o site.", [
    { action: "account:name", label: "Alterar nome" },
    { action: "account:phone", label: "Alterar telefone" },
    { action: "account:addresses", label: "Meus endereços" },
    { action: "account:site", label: "Cadastro no site" },
    { action: "menu", label: "Menu" }
  ]);
}

async function listAddresses(flow: Flow) {
  flow.state.accountEdit = undefined;
  flow.state.phase = "account";
  const all = await flow.api.addresses(flow.customerId);
  const addresses = all.slice(0, 8);
  if (all.length > addresses.length) flow.say("Outros endereços estão disponíveis na sua conta: " + flow.api.accountUrl("/conta/enderecos"));
  flow.choices(addresses.length
    ? "Seus endereços:\n\n" + addresses.map((address, index) => `${index + 1}. ${address.label}` +
        (address.details?.isDefault ? " (padrão)" : "")).join("\n\n")
    : "Você ainda não cadastrou endereços.", [
    ...addresses.map((address, index) => ({ action: "account:address:" + address.id, label: "Endereço " + (index + 1) })),
    { action: "account:new", label: "Novo endereço" },
    { action: "account:home", label: "Meus dados" }
  ]);
}

function askField(flow: Flow) {
  const edit = flow.state.accountEdit;
  if (!edit) return;
  flow.state.phase = "account_input";
  const prompt = edit.kind === "profile"
    ? edit.field === "fullName" ? "Digite seu nome completo." : "Digite o telefone com DDD. Para remover o telefone de contato, escreva remover."
    : `Digite ${labels[edit.field!]}.` + (edit.field === "complement" ? " Se não houver, escreva sem complemento." : "");
  flow.choices(prompt + "\nPara sair sem salvar, escreva cancelar.", [{ action: "account:cancel", label: "Cancelar alteração" }]);
}

function confirmEdit(flow: Flow) {
  const edit = flow.state.accountEdit;
  if (!edit) return;
  flow.state.phase = "account_confirm";
  flow.choices("Confira antes de salvar:\n" + (edit.kind === "profile"
    ? `${edit.field === "fullName" ? "Nome" : "Telefone"}: ${edit.value || "Não informado"}`
    : addressText(edit.values)) + "\n\nPara mudar a entrega combinada de um pedido já feito, consulte a loja.", [
    { action: "account:save", label: "Salvar alteração" },
    { action: "account:cancel", label: "Cancelar alteração" }
  ]);
}

export async function accountAction(value: string, flow: Flow) {
  const [action, id, field] = value.split(":");
  const { api, state, customerId, contactId, eventId, say } = flow;
  switch (action) {
    case "home":
    case "cancel":
      return showAccount(flow);
    case "site":
      say("Para consultar ou corrigir CPF e dados de acesso, entre na sua conta:\n" + api.accountUrl("/conta/perfil"));
      return showAccount(flow);
    case "name":
    case "phone":
      state.accountEdit = { kind: "profile", field: action === "name" ? "fullName" : "phone" };
      return askField(flow);
    case "addresses":
      return listAddresses(flow);
    case "new":
      state.accountEdit = { kind: "address", values: { isDefault: false }, field: "zipCode", creating: true };
      return askField(flow);
    case "address": {
      const address = (await api.addresses(customerId)).find((item) => item.id === id);
      if (!address?.details) {
        say("Endereço não encontrado na sua conta.");
        return listAddresses(flow);
      }
      state.accountEdit = undefined;
      state.phase = "account";
      flow.choices(addressText(address.details) + "\n\nQual informação deseja alterar?", [
        ...fields.map((key) => ({ action: `account:field:${id}:${key}`, label: labels[key] })),
        { action: `account:field:${id}:isDefault`, label: address.details.isDefault ? "Remover padrão" : "Usar como padrão" },
        { action: "account:addresses", label: "Voltar" }
      ]);
      return;
    }
    case "field": {
      if (![...fields, "isDefault"].includes(field)) return listAddresses(flow);
      const address = (await api.addresses(customerId)).find((item) => item.id === id);
      if (!address?.details) return listAddresses(flow);
      state.accountEdit = { kind: "address", id, values: { ...address.details }, field: field as keyof AddressInput, creating: false };
      if (field === "isDefault") {
        state.accountEdit.values.isDefault = !address.details.isDefault;
        return confirmEdit(flow);
      }
      return askField(flow);
    }
    case "default": {
      if (state.accountEdit?.kind !== "address" || !state.accountEdit.creating) return listAddresses(flow);
      state.accountEdit.values.isDefault = id === "yes";
      return confirmEdit(flow);
    }
    case "save": {
      const edit = state.accountEdit;
      if (!edit || state.phase !== "account_confirm") return showAccount(flow);
      try {
        if (edit.kind === "profile") {
          await api.updateProfile(customerId, contactId, { [edit.field]: edit.value }, eventId + ":profile");
        } else {
          const input = addressSchema.parse(edit.values);
          await api.saveAddress(customerId, contactId, input, edit.id, eventId + ":address");
        }
      } catch (error) {
        if (!(error instanceof CustomerActionError)) throw error;
        say(error.message);
        return showAccount(flow);
      }
      state.accountEdit = undefined;
      say("Dados salvos.");
      return edit.kind === "address" ? listAddresses(flow) : showAccount(flow);
    }
  }
}

/** Inputs are considered private fields only after a verified customer chose an edit action. */
export function accountInput(text: string, flow: Flow) {
  const edit = flow.state.accountEdit;
  if (!edit || flow.state.phase !== "account_input") return;
  if (text.trim().toLowerCase() === "cancelar") return showAccount(flow);
  if (edit.kind === "profile") {
    const value = edit.field === "phone" && text.trim().toLowerCase() === "remover" ? "" : text;
    const parsed = profileSchema.shape[edit.field].safeParse(value);
    if (!parsed.success || (typeof parsed.data === "string" && parsed.data.length > 120)) {
      flow.say(parsed.success ? "Use até 120 caracteres." : parsed.error.issues[0].message);
      return askField(flow);
    }
    edit.value = parsed.data;
    return confirmEdit(flow);
  }
  const field = edit.field;
  if (!field || field === "isDefault") return;
  let value = text.trim();
  if (field === "complement" && /^(sem complemento|nenhum|remover)$/i.test(value)) value = "";
  if (field === "state") value = value.toUpperCase();
  const parsed = addressSchema.shape[field].safeParse(value);
  if (!parsed.success || value.length > 200 || (field === "state" && !states.has(value))) {
    flow.say(!parsed.success ? parsed.error.issues[0].message : "Informe um valor válido" + (field === "state" ? ", como SP ou MG." : " de até 200 caracteres."));
    return askField(flow);
  }
  edit.values[field] = parsed.data as string;
  if (!edit.creating) return confirmEdit(flow);
  const next = fields[fields.indexOf(field) + 1];
  if (next) {
    edit.field = next;
    return askField(flow);
  }
  edit.field = undefined;
  flow.state.phase = "account_confirm";
  flow.choices("Deseja usar este endereço como padrão?", [
    { action: "account:default:yes", label: "Sim, usar padrão" },
    { action: "account:default:no", label: "Não" },
    { action: "account:cancel", label: "Cancelar alteração" }
  ]);
}
