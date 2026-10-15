/* eslint-disable @typescript-eslint/no-require-imports -- The sibling Express API uses ts-node/CommonJS. */
// Test transport for the real Core financial service. It never loads the live .env.
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const database = new URL(process.env.PONTALTI_FINANCE_E2E_DATABASE_URL || "");
if (
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  database.pathname !== "/pontalti_finance_e2e_test" ||
  process.env.PONTALTI_FINANCE_TEST_ONLY !== "true"
) throw new Error("ISOLATED_CORE_FINANCE_TEST_DATABASE_REQUIRED");
process.env.DATABASE_URL = database.toString();
process.env.CORA_ENV = "production";
process.env.CORA_TRANSFERS_ENABLED = "false";
process.env.CORA_PAYROLL_WORKER_ENABLED = "false";
process.env.CORA_CUSTOMER_DEPOSITS_ENABLED = "true";
const coreRoot = path.resolve(__dirname, "../../../pontalti-core-api");
require(coreRoot + "/node_modules/ts-node").register({ project: coreRoot + "/tsconfig.json" });
require(coreRoot + "/node_modules/tsconfig-paths").register({
  baseUrl: coreRoot + "/src",
  paths: { "@pontalti/*": ["./*"] }
});
const express = require(coreRoot + "/node_modules/express");
const { PrismaClient } = require(coreRoot + "/node_modules/@prisma/client");
const { CustomerFinanceService } = require(coreRoot + "/src/modules/v1/customer-finance/customer-finance-service");
const { createAdminFinanceRouter, createInternalFinanceRouter } = require(coreRoot + "/src/modules/v1/customer-finance/routes");
const db = new PrismaClient();

class SimulatedCora {
  invoices = new Map();
  bankEntries = [];
  invoiceCreates = 0;
  context = () => ({
    environment: "PRODUCTION", connectionKey: "isolated-finance-e2e-cora",
    configured: true, transfersEnabled: false, workerEnabled: false
  });
  createCustomerInvoice = async (payload, key) => {
    this.invoiceCreates++;
    const id = "inv_finance_e2e_" + key;
    if (!this.invoices.has(id)) this.invoices.set(id, {
      id, code: payload.code, status: "OPEN", total_paid: 0,
      total_amount: payload.services.reduce((sum, item) => sum + item.amount, 0),
      payment_options: { bank_slip: { url: "https://test.invalid/topup.pdf", digitable: "BOLETO-ISOLADO-DE-TESTE" } }
    });
    return structuredClone(this.invoices.get(id));
  };
  customerInvoice = async (id) => {
    if (!this.invoices.has(id)) throw new Error("SIMULATED_INVOICE_NOT_FOUND");
    return structuredClone(this.invoices.get(id));
  };
  statement = async (start, end, page) => ({
    entries: page === 1 ? this.bankEntries.filter((entry) => {
      const date = entry.createdAt.slice(0, 10);
      return date >= start && date <= end;
    }) : []
  });
}

const cora = new SimulatedCora();
const service = new CustomerFinanceService(db, cora);
let admin;
const app = express();
app.use(express.json());
const control = (fn) => (req, res, next) => Promise.resolve(fn(req)).then((data) => res.json(data)).catch(next);
app.get("/__test/ready", (_req, res) => res.json({ testOnly: true }));
app.post("/__test/reset", control(async () => {
  const current = await db.$queryRawUnsafe("SELECT current_database() AS name");
  if (current[0].name !== "pontalti_finance_e2e_test") throw new Error("REFUSING_REAL_DATABASE");
  await db.$executeRawUnsafe('TRUNCATE "Users", "Customers", "Cores", "Espumas", "Orders", "Adresses" RESTART IDENTITY CASCADE');
  cora.invoices.clear(); cora.bankEntries = []; cora.invoiceCreates = 0;
  admin = await db.users.create({ data: {
    name: "Finance E2E Admin", email: "finance-e2e@example.test", password: "not-a-login", access_level: "administrator"
  } });
  const color = await db.cores.create({ data: { name: "Finance E2E", short_code: "FE", status: 1 } });
  const foam = await db.espumas.create({ data: { name: "Finance E2E", short_code: "FE", size: "M", status: 1 } });
  await db.products.create({ data: {
    id: 991, type: "bojo", inner_color_id: color.id, outer_color_id: color.id,
    foam_id: foam.id, sku: "TEST-A", status: 1
  } });
  await db.customers.create({ data: {
    name: "Cliente de teste A", cpf: "52998224725", status: 1, credit_limit: 0, debts: 0,
    store_name: "Loja E2E", deliver: false, pontalti: false, secondary_line: false, updated_at: new Date(),
    address: { create: { zip_code: "01001000", neighborhood: "Teste", public_place: "Rua E2E", city: "São Paulo", state: "SP", address_number: 1 } }
  } });
  return { reset: true };
}));
app.get("/__test/state", control(async () => ({
  customers: await db.customers.findMany({ select: { id: true, debts: true, credit_limit: true } }),
  orders: await db.orders.findMany({ select: { id: true, final_price: true, customer_id: true, status: true } }),
  payments: await db.payments.findMany({ select: { id: true, amount_paid: true, remaining: true, order_id: true } }),
  entries: await db.customerFinanceEntry.findMany({ select: { kind: true, amount_cents: true, customer_id: true } }),
  invoiceCreates: cora.invoiceCreates,
  simulatedBank: true
})));
app.post("/__test/invoices/:id/paid", control(async (req) => {
  const invoice = cora.invoices.get(req.params.id);
  if (!invoice) throw new Error("SIMULATED_INVOICE_NOT_FOUND");
  invoice.status = "PAID"; invoice.total_paid = invoice.total_amount;
  return { paid: true };
}));
app.post("/__test/fund", control(async (req) => {
  const deposit = await service.createDeposit({
    idempotency_key: randomUUID(), external_customer_id: req.body.external_customer_id,
    amount_cents: req.body.amount_cents, environment: "PRODUCTION"
  }, "BOLETO");
  const invoice = cora.invoices.get(deposit.invoice_id);
  invoice.status = "PAID"; invoice.total_paid = invoice.total_amount;
  await service.syncDeposit(deposit.id, "PRODUCTION");
  return deposit;
}));
app.post("/__test/bank-credit", control(async (req) => {
  const entry = {
    id: "entry_e2e_" + randomUUID(), type: "CREDIT", amount: req.body.amount_cents,
    createdAt: new Date().toISOString(), transaction: {
      id: "trn_e2e_" + randomUUID(), type: "TRANSFER", description: "Recebimento simulado para conferência",
      counterParty: { name: "Cliente de teste A", identity: "52998224725" }
    }
  };
  cora.bankEntries.push(entry);
  const day = entry.createdAt.slice(0, 10);
  await service.syncBankEntries(day, day);
  return { added: true };
}));
app.use("/api/v1/commerce-finance", createInternalFinanceRouter(service));
app.use("/api/v1/customer-finance", (req, _res, next) => { req.user = admin; next(); }, createAdminFinanceRouter(service));
app.use((error, _req, res, next) => {
  void next;
  res.status(500).json({ message: error.message });
});
const server = app.listen(Number(process.env.PONTALTI_FINANCE_TEST_PORT || 35511), "127.0.0.1", () => {
  process.stdout.write("CORE_FINANCE_TEST_READY\n");
});
const stop = () => server.close(async () => { await db.$disconnect(); process.exit(0); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
