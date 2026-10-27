# Chat unificado multiplataforma

App de escritorio personal que junta en una sola ventana flotante el chat y las alertas de Twitch, TikTok, YouTube y Kick. La usarán dos personas (el autor y su hermano), cada una con sus propias cuentas y en su propia PC.

La especificación completa (diseño, colores, integración por plataforma, arquitectura, formato de eventos, empaquetado y plan por fases) está en `docs/chat-unificado-especificacion.md`. Léela antes de empezar cualquier tarea.

## Decisiones tomadas

- **Lenguaje:** TypeScript.
- **Tipo de app:** backend local en Node.js que sirve la interfaz en `localhost`. Después se empaqueta con Electron (`electron-builder`) como instalador `.exe` con ventana flotante. El dock de OBS es opcional y usa la misma URL local.
- **No** es una web alojada ni un plugin nativo de OBS.
- **Un conector por plataforma** que traduce sus eventos al formato común de la sección 5.1 de la especificación.
- **Librerías previstas:** `tmi.js` (chat de Twitch), EventSub por WebSocket (alertas de Twitch), `tiktok-live-connector` (TikTok, con clave de Euler Stream), `liveChatMessages.streamList` de la API de YouTube, WebSocket de Pusher para Kick.
- **TTS fuera de alcance:** se sigue usando Tikfinity.
- **Descartado por ahora:** modo compacto sobre el juego y "pendientes".

## Reglas del proyecto

- Responder y comentar en español.
- El código va en inglés: nombres de archivos, variables, funciones, tipos, clases CSS, atributos `data-*` y claves de configuración. Los comentarios del código siguen en español, igual que todo lo que ve el usuario (textos de la interfaz y mensajes de consola).
- Sistema operativo de desarrollo: Windows.
- Evitar dependencias con módulos nativos (no hay Python ni herramientas de compilación de Visual Studio instaladas).
- Nunca incluir secretos en el código ni en el instalador. Claves y tokens van en un archivo `.env` (incluido en `.gitignore`) o en el almacenamiento local de la app.
- Login con flujos para apps públicas: PKCE o Device Code en Twitch, PKCE en Kick, cliente de escritorio en Google.
- Las conexiones deben reconectarse solas y reportar su estado a la interfaz.
- Se trabaja **una plataforma a la vez**, en este orden: Twitch → TikTok → YouTube → Kick. No se empieza la siguiente hasta terminar la actual.

## Plan por plataformas

**Fase 1 — Twitch** (también sienta la base común del proyecto)
1. Crear el proyecto en TypeScript y un script que imprima en la consola el chat de Twitch (lectura anónima con `tmi.js`).
2. Conector de Twitch con el formato común de evento (sección 5.1).
3. Interfaz en `localhost`: chat, panel de alertas, colores y filtros, usable desde el navegador.
4. Pantalla de configuración y almacenamiento local.
5. Login con botón (PKCE o Device Code) y alertas por EventSub: follows, subs, bits y puntos.
6. Reglas NUEVO y PREGUNTA.

**Fase 2 — TikTok**
- Conector con `tiktok-live-connector` y clave de Euler Stream: chat, follows y regalos.
- NUEVO a partir de los usuarios ya vistos guardados localmente, y agrupación de combos de regalos.
- Tarjeta de configuración con usuario de TikTok y clave de Euler.

**Fase 3 — YouTube**
- Login con Google (cliente de escritorio) y chat con `liveChatMessages.streamList`, cuidando la cuota.
- Alertas de Super Chats y membresías.

**Fase 4 — Kick**
- Login con PKCE y chat y alertas por el WebSocket de Pusher.

**Fase 5 — Empaquetado**
- Electron: ventana flotante, bandeja, instalador `.exe` y actualizaciones automáticas.

## Fase actual

**Fase 2 — TikTok.** La fase 1 (Twitch) está terminada:

- Formato común en `src/core/event.ts` (tipo `ChatEvent`), mensajes servidor → interfaz en `src/core/protocol.ts` y base de conectores en `src/core/connector.ts`.
- Configuración (tipos, valores por defecto y validación) en `src/core/config.ts`. Se guarda en `%APPDATA%\chat-unificado\config.json` (`src/storage.ts`; la variable `CHAT_UNIFICADO_DATA_DIR` cambia la carpeta, útil para pruebas). La clave de Euler nunca se manda a la interfaz.
- `src/connector-manager.ts` enciende, apaga o recrea los conectores cuando cambia la configuración, y aplica las reglas a cada evento.
- Reglas en `src/core/rules.ts` (con pruebas en `rules.test.ts`): NUEVO respeta lo que indique la plataforma (Twitch manda `first-msg`); PREGUNTA = "?" o "¿" fuera de enlaces, o mención al streamer (su canal/cuenta y los apodos de la configuración, palabra completa, con o sin @, sin importar mayúsculas ni acentos). Los mensajes del propio streamer no se marcan. Las plataformas que no indiquen NUEVO lo calcularán con los usuarios ya vistos guardados localmente.
- Conector de Twitch en `src/connectors/twitch.ts` (chat anónimo con tmi.js y, con sesión, alertas) y conector de prueba en `src/connectors/demo.ts`.
- Login de Twitch con Device Code en `src/twitch/auth.ts` (app pública, `TWITCH_CLIENT_ID` en `.env`). La sesión se guarda en `twitch-session.json`, aparte de la configuración; los tokens nunca van a la interfaz. Con sesión, el canal del chat es el de la cuenta.
- Alertas por EventSub WebSocket en `src/twitch/eventsub.ts`: follows, subs, resubs, subs regaladas (tipo `giftsub`), bits, puntos y raids (tipo `raid`).
- En el chat de Twitch: emotes nativos como imagen (`fragments` en el evento, parseados con `buildFragments`, con pruebas), mensajes con bits y mensajes destacados con puntos resaltados (`highlight`). Los emotes de 7TV/BTTV/FFZ todavía no se muestran.
- Servidor local (HTTP + WebSocket en `/ws`, puerto 4848, `PUT /api/config`, `POST /api/twitch/*`) en `src/server.ts`; arranca desde `src/main.ts`. Solo acepta Host y Origin de `localhost`/`127.0.0.1`.
- Interfaz en `src/ui/`: `app.ts` (chat y alertas), `settings.ts` (pantalla en `#settings`), `index.html` y `styles.css`. Los `.ts` se compilan con `tsconfig.ui.json` a `dist/web`, que el servidor sirve en `/js/`.
- Logos de plataforma en `src/ui/logos/` (PNG 64 × 64 sin fondo): en mensajes, alertas, pastillas de estado, filtros y tarjetas de configuración.
- Opción de configuración `window.alertsSide` ("left" | "right") para poner el panel de alertas a un lado u otro del chat. En ventanas angostas las alertas van siempre arriba.
- Comandos: `npm start` (app), `npm run demo` (app con eventos de prueba), `npm run console`, `npm run typecheck`, `npm test`.

### Pendientes de Twitch (no bloquean la fase 2)

- Emotes de 7TV, BTTV y FFZ (ahora se ven como texto).
- Probar en un stream real: follows, subs, subs regaladas, bits y raids. Solo se probó en vivo el canje de puntos; las suscripciones de EventSub sí están activas.
- Probar la renovación real del token (a las ~4 h) y la reconexión tras un corte de internet.
- Opcional: ocultar o tachar mensajes borrados por moderadores y de usuarios baneados.

### Para la fase 5 (Electron)

- Aplicar "Siempre encima", "Iniciar con Windows" y la opacidad (ya se guardan en la configuración).
- Cifrar la sesión de Twitch y la clave de Euler con `safeStorage` (ahora van en JSON sin cifrar, solo en la PC del usuario).
- Incluir el Client ID de Twitch en la app para que el hermano no tenga que configurar `.env`.
- Abrir la página de autorización con `shell.openExternal` (ahora se usa `rundll32` desde el backend).
