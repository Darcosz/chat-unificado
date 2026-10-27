// Muestra en la consola los eventos de todos los conectores activos.
// Sirve para probar los conectores sin abrir la interfaz.
// Uso: npm run console                   (canal de TWITCH_CHANNEL en .env)
//      npm run console -- canal          (el argumento tiene prioridad)
//      npm run console -- canal --json   (imprime cada evento en el formato común)

import { styleText } from "node:util";
import type { Connector } from "./core/connector.ts";
import { isChat, type ChatEvent, type Platform } from "./core/event.ts";
import { STATUS_TEXT } from "./core/protocol.ts";
import { TwitchConnector } from "./connectors/twitch.ts";

type Style = Parameters<typeof styleText>[0];

const STYLES: Record<Platform, { label: Style; name: Style }> = {
  twitch: { label: ["bgMagenta", "white", "bold"], name: ["magentaBright", "bold"] },
  tiktok: { label: ["bgCyan", "black", "bold"], name: ["cyanBright", "bold"] },
  youtube: { label: ["bgRed", "white", "bold"], name: ["redBright", "bold"] },
  kick: { label: ["bgGreen", "black", "bold"], name: ["greenBright", "bold"] },
};

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const twitchChannel = args.find((a) => !a.startsWith("--")) ?? process.env.TWITCH_CHANNEL;

const connectors: Connector[] = [];
if (twitchChannel?.trim()) connectors.push(new TwitchConnector(twitchChannel));

if (connectors.length === 0) {
  console.error("No hay ninguna plataforma configurada. Pon el canal en TWITCH_CHANNEL dentro de .env o pásalo así: npm run console -- nombre_del_canal");
  process.exit(1);
}

function time(date = new Date()): string {
  return date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function print(event: ChatEvent): void {
  if (jsonMode) {
    console.log(JSON.stringify(event));
    return;
  }

  const style = STYLES[event.platform];
  const label = styleText(style.label, ` ${event.platform.toUpperCase()} `);
  const isNew = event.flags.firstTime ? styleText(["bgYellow", "black", "bold"], " NUEVO ") + " " : "";
  const name = styleText(style.name, event.user.name);

  if (isChat(event)) {
    console.log(`${time(new Date(event.timestamp))} ${label} ${isNew}${name}: ${event.text ?? ""}`);
  } else {
    const extras = [event.amount, event.detail, event.text].filter((x) => x !== undefined && x !== "");
    console.log(`${time(new Date(event.timestamp))} ${label} ${styleText("bold", `[${event.type.toUpperCase()}]`)} ${name} ${extras.join(" · ")}`);
  }
}

for (const connector of connectors) {
  connector.on("status", (status, detail) => {
    const text = `${time()} [${connector.platform}] ${STATUS_TEXT[status]}${detail ? `: ${detail}` : ""}`;
    // El estado va a stderr para no mezclarse con los eventos en modo --json.
    console.error(styleText("gray", text));
  });
  connector.on("event", print);
  void connector.connect();
}

process.on("SIGINT", () => {
  void Promise.allSettled(connectors.map((c) => c.disconnect())).then(() => process.exit(0));
});
