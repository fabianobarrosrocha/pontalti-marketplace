import { loadEnvConfig } from "@next/env";
import { setTimeout } from "node:timers/promises";

async function main() {
  loadEnvConfig(process.cwd());
  if (process.env.WHATSAPP_BOT_ENABLED !== "true" || process.env.WHATSAPP_BOT_SEND_MODE !== "live") {
    throw new Error("Configure WHATSAPP_BOT_ENABLED=true e WHATSAPP_BOT_SEND_MODE=live para iniciar o worker.");
  }
  if (process.env.WHATSAPP_PROVIDER !== "evolution") throw new Error("Esta versão usa WHATSAPP_PROVIDER=evolution.");
  const { workerDependencies, workerTick } = await import("../src/lib/whatsapp/worker");
  const deps = workerDependencies();
  if (!deps.account) throw new Error("Configure EVOLUTION_INSTANCE.");
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  console.log("Worker WhatsApp iniciado.");
  do {
    try {
      await workerTick(deps);
    } catch {
      console.error("Falha temporária no worker; as tarefas permanecem no banco.");
    }
    if (process.argv.includes("--once")) break;
    if (!stopping) await setTimeout(1000);
  } while (!stopping);
}
main().catch(() => {
  console.error("Worker não iniciou. Confira configuração e migrations.");
  process.exitCode = 1;
});
