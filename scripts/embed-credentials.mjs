// Integra en el paquete las credenciales de las apps públicas (Client ID de Twitch y cliente de
// escritorio de Google), tomadas del .env del proyecto. Se escriben en dist/credentials.json,
// que git ignora: nunca llegan al repositorio, solo al instalador.
// Nunca se integran tokens de usuario ni claves con límite de uso (como la de Euler).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const KEYS = ["TWITCH_CLIENT_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const values = {};

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && KEYS.includes(match[1]) && match[2]) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

mkdirSync("dist", { recursive: true });
writeFileSync("dist/credentials.json", JSON.stringify(values, null, 2));

const missing = KEYS.filter((key) => !values[key]);
console.log(missing.length ? `Credenciales integradas, faltan: ${missing.join(", ")}` : "Credenciales integradas: Twitch y Google.");
