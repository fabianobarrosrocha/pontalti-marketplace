import { test } from "node:test";
import assert from "node:assert/strict";
import { disableCoreFinanceForLocalFixtures } from "../scripts/support/local-finance-isolation";
import { customerFinanceEnvironment, financeRequest } from "@/lib/commerce/customer-finance";

test("local fixture tools discard inherited production finance credentials before any factory request", async () => {
  const names = ["CORE_API_URL", "CUSTOMER_FINANCE_INTERNAL_TOKEN", "CUSTOMER_FINANCE_ENVIRONMENT", "CORA_ENV", "CORA_CLIENT_ID", "NEXT_PUBLIC_SUPABASE_URL"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  try {
    process.env.CORE_API_URL = "http://127.0.0.1:3101/api/v1";
    process.env.CUSTOMER_FINANCE_INTERNAL_TOKEN = "production-shaped-private-test-token-never-used";
    process.env.CUSTOMER_FINANCE_ENVIRONMENT = "PRODUCTION";
    process.env.CORA_ENV = "stage";
    process.env.CORA_CLIENT_ID = "stage-only-test-client";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:55440";
    globalThis.fetch = async () => { requests++; throw new Error("No network should be attempted"); };

    disableCoreFinanceForLocalFixtures();

    assert.equal(process.env.CORE_API_URL, undefined);
    assert.equal(process.env.CUSTOMER_FINANCE_INTERNAL_TOKEN, undefined);
    assert.equal(process.env.CUSTOMER_FINANCE_ENVIRONMENT, undefined);
    assert.equal(process.env.CORA_ENV, "stage");
    assert.equal(process.env.CORA_CLIENT_ID, "stage-only-test-client");
    assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:55440");
    assert.throws(customerFinanceEnvironment, /saldo ainda não está disponível/);
    await assert.rejects(financeRequest("/customers/link", {
      external_customer_id: "10000000-0000-4000-8000-000000000003", environment: "PRODUCTION"
    }), /saldo está temporariamente indisponível/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
