// Port overrides let automated checks run beside a live WhatsApp test conversation.
export const TEST_DATABASE_URL = process.env.PONTALTI_WHATSAPP_TEST_DATABASE_URL ??
  "postgres://postgres:pontalti-local-test@127.0.0.1:55439/pontalti_whatsapp_test";
export const TEST_API_URL = process.env.PONTALTI_WHATSAPP_TEST_API_URL ?? "http://127.0.0.1:55440";
const database = new URL(TEST_DATABASE_URL);
const api = new URL(TEST_API_URL);
if (!["localhost", "127.0.0.1"].includes(database.hostname) ||
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  database.pathname !== "/pontalti_whatsapp_test" || database.search ||
  !["localhost", "127.0.0.1"].includes(api.hostname) || api.protocol !== "http:" ||
  api.pathname !== "/" || api.search || api.username || api.password) {
  throw new Error("LOCAL_WHATSAPP_TEST_DATABASE_REQUIRED");
}
