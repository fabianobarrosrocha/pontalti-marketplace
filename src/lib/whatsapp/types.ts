import type { AddressInput } from "@/lib/validation";
import type { CustomerBalance, DepositClaim, CustomerAccountEntry } from "@/lib/commerce/customer-finance";

export type BotOption = { id: string; label: string };
export type BotProductCard = { productId: string; title: string; text: string; imageUrl: string | null; options: BotOption[] };
export type BotMessage = (
  | { type: "text"; text: string; literal?: true }
  | { type: "image"; url: string; caption: string }
  | { type: "document"; url: string; filename: string; caption: string }
  | { type: "choices"; text: string; imageUrl?: string; options: BotOption[] }
  | ({ type: "product" } & BotProductCard)
  | {
      type: "carousel";
      text: string;
      cards: BotProductCard[];
    }
) & { customerId?: string };

export type Selection = { productId: string; quantity: number };
export class CustomerActionError extends Error {}
export type BotProduct = {
  id: string;
  title: string;
  sku: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  url: string;
};
export type BotCart = {
  version: number;
  items: (Selection & { title: string; priceCents: number; available: boolean })[];
  subtotalCents: number;
};
export type DeliveryPolicy = { enabled: boolean; description: string; feeCents: number; states: string[] };
export type BotSettings = { unitLabel: string; delivery: DeliveryPolicy };
export type BotAddress = { id: string; label: string; state: string; details?: AddressInput };
export type BotProfile = { fullName: string; phone: string | null };
export type RepeatLine = Selection & { title: string; priceCents: number; available: boolean };
export type AccountEdit =
  | { kind: "profile"; field: keyof BotProfile; value?: string | null }
  | { kind: "address"; id?: string; values: Partial<AddressInput>; field?: keyof AddressInput; creating: boolean };
export type BotOrder = {
  id: string;
  status: string;
  totalCents: number;
  delivery: string | null;
  payment: {
    status: string;
    pix: string | null;
    boleto: string | null;
    digitable: string | null;
    dueDate: string | null;
  } | null;
  balanceDebtCents?: number;
  balanceNeedsReview?: boolean;
  balanceReservedCents?: number;
};
export type BotState = {
  customerId?: string | null;
  phase?: "menu" | "catalog" | "quantity" | "cart" | "merge" | "address" | "confirm" | "orders" | "payment" | "faq" | "account" | "account_input" | "account_confirm" | "repeat" | "balance_confirm" | "finance_input" | "finance_confirm";
  accountEdit?: AccountEdit;
  repeat?: { orderId: string; lines: RepeatLine[] };
  pending?: Selection[];
  catalogIds?: string[];
  page?: number;
  query?: string;
  choices?: { action: string; label: string }[];
  menuVersion?: number;
  productId?: string;
  quantityMode?: "increment" | "set";
  preview?: { addressId: string; cartVersion: number; subtotalCents: number; feeCents: number; delivery: string;
    balanceConsent?: { account_revision: number; projected_balance_cents: number } };
  orderId?: string;
  balanceQuote?: { availableCents: number; projectedCents: number; totalCents: number };
  depositInput?: { kind: "BOLETO" | "BANK_CLAIM"; amountCents?: number; depositedAt?: string; reference?: string };
  balanceReviewOrderId?: string;
};
export type BotContext = {
  eventId: string;
  conversationId: string;
  contactId: string;
  customerId: string | null;
  version: number;
  text: string;
};

/** Toda operação com dados privados recebe o comprador verificado no servidor. */
export interface BotServices {
  settings(): Promise<BotSettings>;
  catalog(query: string, page: number): Promise<{ products: BotProduct[]; hasMore: boolean }>;
  products(ids: string[]): Promise<BotProduct[]>;
  cart(customerId: string): Promise<BotCart>;
  mutateCart(
    customerId: string,
    items: Selection[],
    mode: "increment" | "set" | "clear",
    operationId: string
  ): Promise<void>;
  profileComplete(customerId: string): Promise<boolean>;
  profile(customerId: string): Promise<BotProfile>;
  updateProfile(customerId: string, contactId: string, patch: Partial<BotProfile>, operationId: string): Promise<void>;
  saveAddress(customerId: string, contactId: string, input: AddressInput, id: string | undefined, operationId: string): Promise<void>;
  addresses(customerId: string): Promise<BotAddress[]>;
  repeatPreview(customerId: string, orderId: string): Promise<RepeatLine[] | null>;
  repeatOrder(customerId: string, contactId: string, orderId: string, lines: RepeatLine[], operationId: string): Promise<void>;
  orders(customerId: string, options?: { page?: number; awaitingPayment?: boolean }): Promise<BotOrder[]>;
  order(customerId: string, orderId: string): Promise<BotOrder | null>;
  checkout(
    customerId: string,
    preview: NonNullable<BotState["preview"]>,
    conversationId: string
  ): Promise<{ orderId: string; status: string }>;
  createLink(contactId: string, operationId: string): Promise<string>;
  confirmLink(contactId: string, code: string, eventId: string): Promise<string | null>;
  unlink(contactId: string): Promise<void>;
  articles(): Promise<{ id: string; title: string; answer: string }[]>;
  accountUrl(path: string): string;
  finance?: {
    summary(customerId: string): Promise<CustomerBalance>;
    deposits(customerId: string): Promise<DepositClaim[]>;
    statement?(customerId: string): Promise<CustomerAccountEntry[]>;
    deposit(customerId: string, amountCents: number, operationId: string): Promise<DepositClaim>;
    claim(customerId: string, input: { amountCents: number; depositedAt: string; reference: string }, operationId: string): Promise<DepositClaim>;
    checkout(customerId: string, preview: NonNullable<BotState["preview"]>, conversationId: string): Promise<{ orderId: string; status: string }>;
    renewConsent?(customerId: string, orderId: string, consent: { account_revision: number; projected_balance_cents: number }): Promise<void>;
  };
}
