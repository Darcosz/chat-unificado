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
- Nunca incluir secretos en el código ni en el repositorio. Las credenciales de las apps públicas (Client ID de Twitch, y Client ID y secreto del cliente de escritorio de Google, que Google no considera confidencial) **sí van integradas en el instalador** (decidido con el usuario, sabiendo que el `.exe` se publica en releases públicas y se puede extraer; el peor caso es crear credenciales nuevas y publicar una versión). Nunca se integran tokens de usuario ni claves con límite de uso (como la de Euler), que se guardan cifradas en el almacenamiento local de la app.
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
- Conector con `tiktok-live-connector` y clave de Euler Stream: chat, follows, regalos y compartidos (decidido con el usuario; likes y entradas al live quedan fuera porque llenarían el panel).
- No hay login: TikTok solo da acceso a los eventos del live a socios aprobados. La librería lee el live como un espectador, con el usuario del canal, y la conexión solo funciona mientras está en vivo.
- NUEVO a partir de los usuarios ya vistos guardados localmente, y agrupación de combos de regalos.
- Tarjeta de configuración con usuario de TikTok y clave de Euler.

**Fase 3 — YouTube**
- Login con Google (cliente de escritorio) y chat con `liveChatMessages.streamList`, cuidando la cuota.
- Alertas de Super Chats y membresías.

**Fase 4 — Kick** (después de la fase 5)
- Sin login. Chat y alertas leyendo el chat emergente de Kick en una ventana oculta de Electron (Cloudflare bloquea las peticiones que no vienen de un navegador). Canal configurable en su tarjeta.

**Fase 5 — Empaquetado** (hecha)
- Electron: ventana flotante, bandeja, instalador `.exe` y actualizaciones automáticas.

## Fase actual

**Fase 5 — Empaquetado con Electron, hecha** (se adelantó a Kick: Kick necesita el navegador integrado de Electron, ver más abajo).

- Electron 45 (trae Node 24.22, el mismo que usamos) + `electron-builder` 26 (instalador NSIS de un clic, por usuario) + `electron-updater` (releases de GitHub `Darcosz/chat-unificado`).
- El arranque está en `src/app.ts` (`startApp`), común a la consola (`src/main.ts`) y a la app de escritorio (`src/desktop/main.ts`). El backend corre **dentro del proceso principal de Electron** (sin un Node aparte).
- `src/desktop/main.ts`: una sola copia (si se abre otra, se enfoca la primera), ventana 860 × 820 que recuerda posición y tamaño (`window.json`), sin menú, icono en la bandeja (Mostrar / Salir), cerrar la ventana cierra la app. Aplica al momento "siempre encima" (nivel `floating`), opacidad e "iniciar con Windows" (solo en la app instalada). La ventana no puede navegar fuera de localhost; los enlaces https se abren en el navegador del sistema (`setUrlOpener` → `shell.openExternal`).
- **Secretos cifrados** con `safeStorage` asíncrono (protección de datos de Windows): sesiones de Twitch y YouTube (`{ "encrypted": ... }`) y la clave de Euler (`"enc:..."` dentro de `config.json`). Los archivos viejos sin cifrar se leen y se cifran al volver a guardarse. **Con Node (`npm run server`) no se pueden leer los datos cifrados**: ese modo es solo para desarrollo.
- **Credenciales:** al compilar, `scripts/embed-credentials.mjs` toma `TWITCH_CLIENT_ID`, `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` del `.env` del proyecto y los escribe en `dist/credentials.json` (ignorado por git), que va dentro del instalador. Así, al instalar o reinstalar solo hay que conectar las cuentas. Prioridad: `%APPDATA%\chat-unificado\.env` (para cambiarlas sin reinstalar) → `.env` del proyecto → integradas. Comprobado: la app empaquetada sin ningún `.env` tiene disponibles los logins de Twitch y YouTube.
- `src/paths.ts` (`APP_ROOT`) encuentra la carpeta de la app tanto en `src/` como dentro de `app.asar`. El backend se compila con `tsconfig.backend.json` a `dist/backend` y se copia el `.proto` de YouTube.
- Icono propio en `assets/icon.png` (256 × 256: burbuja de chat con los cuatro colores de plataforma).
- Comandos: `npm start` (app de escritorio), `npm run start:demo`, `npm run server` / `npm run demo` (solo backend con Node, para el navegador), `npm run dist` (instalador en `release/`).
- Medido: app empaquetada con Twitch conectado, **~240 MB de memoria privada y 0,4-0,8 % de un núcleo de CPU**. Instalador de 118,5 MB.
- Actualizaciones: para publicar una versión se sube a una release de GitHub (etiqueta `vX.Y.Z`) el `.exe`, el `.blockmap` y `latest.yml` de `release/`; las apps instaladas con "Actualizar automáticamente" la descargan solas.

Siguiente: **Fase 4 — Kick con el navegador integrado de Electron.** Kick protege con Cloudflare los datos del chat (número del chatroom y configuración en tiempo real, que ahora puede ser Pusher o Centrifugo) y bloquea a lo que no sea un navegador; esquivarlo (por ejemplo con `curl`) es saltarse una protección anti-bots y **no se hace**. El plan acordado: abrir `kick.com/popout/<canal>/chat` en una ventana oculta de Electron (un navegador real, como Social Stream Ninja) y leer de ahí los mensajes; solo si Kick está encendido y en bajo consumo. Sin login.

**Fase 3 — YouTube, en pruebas.** Hecho:

- Proyecto de Google Cloud con YouTube Data API v3, pantalla de consentimiento "In production" sin verificar (política de privacidad en `PRIVACY.md` del repo público) y cliente OAuth "App de escritorio". `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env`.
- Login en `src/youtube/auth.ts`: redirección a `http://127.0.0.1:<puerto>/oauth/google/callback` (página GET del servidor) con PKCE y `state`; `access_type=offline` + `prompt=consent` para el refresh token. Permiso único `youtube.readonly`. Sesión en `youtube-session.json`; se renueva sola y "Desconectar" revoca el token. Probado con el canal ArcoszCR.
- Conector en `src/connectors/youtube.ts`: busca el directo activo con `liveBroadcasts.list?broadcastStatus=active&broadcastType=all` (1 unidad; **no** combinar con `mine`: da `incompatibleParameters`); sin directo reintenta de 1 a 3 min.
- Chat con `liveChatMessages.streamList`, que **solo existe por gRPC** (`youtube.googleapis.com:443`, token en la cabecera `authorization`). Librerías `@grpc/grpc-js` y `@grpc/proto-loader` (JS puro); definición en `src/youtube/stream-list.proto` (recortada del oficial, Apache 2.0).
- **YouTube cierra cada flujo a los ~10 s** aunque haya chat; se reabre 4 s después con `nextPageToken` (no se pierden mensajes).
- **`streamList` es inestable:** a menudo responde "overloaded" (código 14 `UNAVAILABLE`) sin importar la espera. Entonces se pasa 2 min a `liveChatMessages.list` (REST) cada **10 s** (decidido con el usuario: ~1,800 u/h) y se vuelve a probar el flujo. Los dos comparten `nextPageToken` (comprobado). REST da los tipos en camelCase (`textMessageEvent`) y se convierten al formato del `.proto`.
- **Lector principal: InnerTube** (`src/youtube/innertube.ts`, decidido con el usuario tras comparar con Social Stream Ninja). Son las peticiones internas de la página de YouTube: se abre `youtube.com/live_chat?is_popout=1&v=<id>`, se toma la versión del cliente y el token de la vista **"Chat en vivo"** (el último del selector; la de por defecto, "Chat destacado", filtra mensajes) y se consulta `youtubei/v1/live_chat/get_live_chat` cada 1-2 s (YouTube sugiere ~5 s, pero así el retraso medido bajó de 4,6 s a 1,1 s de mediana; no gasta cuota). Sin cuota, sin login (anónimo: sirve para directos públicos y sin listar, **no privados**), escrito a mano sin librerías. No es oficial: puede romperse.
- Orden del conector: busca el directo con la API oficial (1 unidad) → lee por InnerTube → si falla 3 veces seguidas, usa la API oficial (gRPC + REST) 10 min y vuelve a probar. Al cambiar de fuente se ignora lo ya mostrado (por fecha), sin repetir. Con la API oficial la tarjeta dice "Usando la API oficial de respaldo".
- Todas las fuentes se traducen a `YouTubeChatItem` (`src/youtube/chat-item.ts`, forma de la API oficial); InnerTube añade `fragments` con los emojis propios del canal como imagen. Pruebas en `innertube.test.ts`.
- Tipos: mensajes, Super Chat y Super Sticker (`superchat`), membresía nueva e hito (`member`), membresías regaladas (`giftsub`, se muestra "regaló N membresías") y regalos (`gift`, combos agrupados por id). El historial inicial anterior a la conexión no se muestra. NUEVO con el registro de usuarios vistos.
- Probado con un directo propio sin listar: la app lo encuentra sola y los mensajes llegan por InnerTube con 0,1-2,2 s de retraso (1,1 s de mediana), con los emojis del canal como imagen. Las reglas comparan los nombres sin @ (YouTube manda "@canal"), así que los mensajes del propio streamer no se marcan como PREGUNTA. Las tarjetas de configuración muestran el motivo del estado (`card-detail`).

Pendiente de la fase 3: ver en un directo real un Super Chat o una membresía (no se pueden simular sin dinero).

**Fase 2 — TikTok, terminada.** Probado con lives reales (`deusamirr`, `pinkyshoww`):

- Conector en `src/connectors/tiktok.ts` con `tiktok-live-connector` 2.5: chat, follows, regalos y compartidos (tipo `share`). Usuario y clave de Euler en la configuración.
- Regalos de combo: se espera al evento con `repeatEnd` y se muestra una sola alerta con el total (si nunca llega, tras 8 s sin novedades).
- `processInitialData: false` (si no, repetiría mensajes viejos en cada reconexión). `enableExtendedGiftInfo` **apagado**: pide la lista de regalos a Euler y es del plan de pago; el nombre ya viene en `gift.name`.
- Reconexión: sin live, reintenta de 30 s a 5 min; con error, de 5 s a 5 min; límite de Euler o función de pago, cada 10 min. Así no se gasta el límite gratuito (2,500 peticiones al día; solo cuenta conectar, no los mensajes).
- NUEVO con el registro de usuarios ya vistos (`src/seen-users.ts`, archivo `seen-users.json`, máx. 50,000 por plataforma). Los conectores indican con `reportsFirstTime` si la plataforma ya lo da (Twitch y el demo sí).
- El evento lleva `user.login` (@usuario) además del nombre visible; las reglas lo usan para no marcar los mensajes del propio streamer.
- Los tipos de eventos de la librería (`typed-emitter`) no se resuelven con `module: nodenext`; el conector usa una vista tipada propia (`TikTokEvents`).

- Compartidos: llegan con la clave `pm_mt_guidance_share` ("X shared the LIVE") y la librería los emite como `share`. Los reposts (`ttlive_repost_…`, "X reposted") la librería los emite como `social`; el conector los convierte en `share` con `detail: "repost"`. Se comprobó con un live real que la app recibe exactamente los mismos follows y compartidos que la librería directa: son poco frecuentes (unos pocos por minuto en un live grande).

Combos de regalos comprobados en un live real: varios regalos seguidos salieron como una sola alerta "× 5". La fase 2 no tiene pendientes.

La fase 1 (Twitch) está terminada:

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
- Comandos (ver también la fase 5): `npm start` (app de escritorio), `npm run server` (solo backend), `npm run demo`, `npm run console`, `npm run typecheck`, `npm test`.

### Uso real

- 29/10/2026: stream de casi 3 horas con Twitch y TikTok a la vez, sin desconexiones y con el chat fluido. En TikTok se vio un combo de regalos agrupado ("× 5"). En Twitch todavía no llegaron follows, subs, bits ni raids.

### Pendientes de Twitch (no bloquean la fase 2)

- Emotes de 7TV, BTTV y FFZ (ahora se ven como texto).
- Probar en un stream real: follows, subs, subs regaladas, bits y raids. Solo se probó en vivo el canje de puntos; las suscripciones de EventSub sí están activas.
- Probar la reconexión tras un corte de internet. (La renovación del token ya se comprobó: la sesión de días antes entró sola.)
- Opcional: ocultar o tachar mensajes borrados por moderadores y de usuarios baneados.

### Pendientes de la fase 5

- Publicar la primera release en GitHub para que funcionen las actualizaciones automáticas.
- Medir la app durante un stream real junto a OBS y los demás programas.
- Sin firma de código: la primera instalación muestra el aviso de SmartScreen (Más información → Ejecutar de todas formas).
