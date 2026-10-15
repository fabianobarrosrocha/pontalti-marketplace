import { readFile } from "node:fs/promises";
import sharp from "sharp";

// Layout da amostra de homologação; preserva as três ilustrações recuperadas do canal.
const names = ["classico", "triangular", "cortininha"];
const panels = await Promise.all(names.map(async (name, index) => ({
  input: await readFile(`infra/whatsapp-live/images/${name}.jpg`),
  left: index * 640,
  top: 0
})));
await sharp({ create: { width: 1920, height: 480, channels: 3, background: "#f5f3ec" } })
  .composite(panels)
  .png()
  .toFile("infra/whatsapp-live/catalog.png");
console.log("Catálogo de homologação atualizado: infra/whatsapp-live/catalog.png");
