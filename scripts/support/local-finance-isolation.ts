/** Local fixture customers must never reach the factory's real customer accounts. */
export function disableCoreFinanceForLocalFixtures(env: NodeJS.ProcessEnv = process.env): void {
  delete env.CORE_API_URL;
  delete env.CUSTOMER_FINANCE_INTERNAL_TOKEN;
  delete env.CUSTOMER_FINANCE_ENVIRONMENT;
}
