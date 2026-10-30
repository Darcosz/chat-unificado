// Versión de consola de la app (sin ventana): arranca el servidor local y los conectores, y se
// usa desde el navegador o el dock de OBS. La app de escritorio está en src/desktop/main.ts.
// Uso: npm run server
//      npm run demo           (eventos de prueba en las plataformas sin conector o sin cuenta)
//      npm run server -- canal (solo la primera vez: guarda ese canal de Twitch si no hay ninguno)

import { startApp } from "./app.ts";

const args = process.argv.slice(2);

try {
  const app = await startApp({
    port: Number(process.env.PORT) || 4848,
    demoMode: args.includes("--demo"),
    ...(args.find((a) => !a.startsWith("--")) ? { initialChannel: args.find((a) => !a.startsWith("--"))! } : {}),
  });

  process.on("SIGINT", () => {
    void app.stop().then(() => process.exit(0));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
