# Chat unificado multiplataforma — Especificación inicial

Documento de referencia con los acuerdos alcanzados hasta ahora para desarrollar una app propia que junte en una sola ventana el chat y las alertas de Twitch, TikTok, YouTube y Kick.

Diseño de referencia (lienzo interactivo): https://claude.ai/artifact/F55AXW79Mkv1yMrexbJfSH

---

## 1. Objetivo

Facilitar la lectura del chat durante los streams. Hoy el chat de Twitch se lee en una ventana flotante de la página de Twitch y el de TikTok en LIVE Studio, lo que obliga a mirar dos lugares. La app debe mostrar todos los mensajes y alertas en una sola ventana, diferenciando claramente de qué plataforma viene cada cosa.

Es una herramienta personal que usarán dos personas (el autor y su hermano), cada una con sus propias cuentas y en su propia PC:

- **Autor:** transmite a Twitch desde OBS y a TikTok desde LIVE Studio.
- **Hermano:** transmite todo desde OBS, con plugins.

Ambos usarán principalmente la **ventana flotante** de la app. El dock de OBS es una opción adicional.

## 2. Alcance

### Incluido

- Chat combinado de Twitch, TikTok, YouTube y Kick.
- Panel de alertas siempre visible al lado del chat.
- Diferenciación por color de plataforma en mensajes y alertas.
- Etiquetas automáticas de **NUEVO** (primera vez que alguien escribe) y **PREGUNTA**.
- Filtros por plataforma.
- Inicio de sesión con botón (OAuth en el navegador) donde la plataforma lo permita.
- Pantalla de configuración y conexiones, independiente para cada usuario.
- Instalador `.exe` que no requiere instalar nada extra.
- Ventana flotante como modo principal; dock de OBS opcional.

### Fuera de alcance por ahora

- **Lectura en voz (TTS):** se mantiene Tikfinity como está.
- **Modo compacto sobre el juego:** descartado por ahora; primero la ventana principal.
- **Pendientes / marcar mensajes:** descartado.
- Enviar mensajes al chat desde la app.

## 3. Diseño de la interfaz

Ventana de escritorio de **860 × 820 px**, tema oscuro, tipografía Inter.

### 3.1 Estructura

```
┌──────────────────────────────────────────────────────────────┐
│ Chat en vivo        ● Twitch  ● TikTok  ● YouTube  ● Kick    │  ← estado de conexión
│ [Todos] [Twitch] [TikTok] [YouTube] [Kick]                   │  ← filtros
├───────────────────────────────────────┬──────────────────────┤
│                                       │ Alertas      N hoy   │
│   CHAT                                │                      │
│   (más antiguo arriba,                │ (más reciente        │
│    más nuevo abajo)                   │  arriba)             │
│                                       │                      │
├───────────────────────────────────────┤      ~330 px         │
│ Auto-scroll activo          [Pausar]  │                      │
└───────────────────────────────────────┴──────────────────────┘
```

- **Cabecera:** título, indicador de conexión por plataforma (punto verde = conectado) y filtros.
- **Columna de chat:** solo mensajes de chat. Auto-scroll con botón para pausarlo; subir el chat lo pausa y volver al final lo reanuda, mostrando cuántos mensajes nuevos llegaron mientras tanto.
- **Panel de alertas:** siempre visible, ancho aprox. 330 px, alertas más recientes arriba y contador de alertas del día. Por defecto a la derecha del chat; se puede poner a la izquierda desde la configuración.
- **Filtros:** aplican a las dos columnas a la vez y se recuerdan al volver a abrir.
- **Ventanas angostas (dock de OBS):** una sola columna, con las alertas arriba y el chat abajo, separados por una línea marcada.

### 3.2 Colores por plataforma

Cada mensaje tiene fondo, borde y nombre de usuario en el color de su plataforma, además de una etiqueta con el nombre completo para no depender solo del color.

| Plataforma | Etiqueta | Fondo etiqueta | Texto etiqueta | Fondo mensaje | Borde mensaje | Nombre usuario |
|---|---|---|---|---|---|---|
| Twitch | TWITCH | `#8B5CF6` | `#FFFFFF` | `#1E1736` | `#5B3FA8` | `#C4B5FD` |
| TikTok | TIKTOK | `#22D3EE` | `#082026` | `#0B262B` | `#1F6B78` | `#67E8F9` |
| YouTube | YOUTUBE | `#DC2626` | `#FFFFFF` | `#2A1214` | `#8B2323` | `#FCA5A5` |
| Kick | KICK | `#53FC18` | `#0A1A03` | `#12260B` | `#3F7A1F` | `#86EFAC` |

**Logos:** junto a la etiqueta de plataforma va el logo oficial (PNG de 64 × 64, sin fondo, en `src/ui/logos/`). Aparece en mensajes, alertas, pastillas de estado, filtros y tarjetas de configuración. El logo es decorativo: el nombre siempre va escrito al lado.

**Emotes:** los emotes de la plataforma se muestran como imagen dentro del mensaje, del alto de una línea. Por ahora solo los nativos de Twitch; los de 7TV, BTTV y FFZ se ven como texto.

### 3.3 Etiquetas de mensaje

| Etiqueta | Cuándo aparece | Colores |
|---|---|---|
| NUEVO | Primera vez que el usuario escribe en el canal | Fondo `#F59E0B`, texto `#1A1204` |
| PREGUNTA | El mensaje contiene "?" o "¿", o menciona al streamer | Fondo `#E8EAED`, texto `#0F1115` |

Reglas detalladas:

- **NUEVO:** se usa lo que indique la plataforma (Twitch manda `first-msg`). Las que no lo indican lo calculan con los usuarios ya vistos, guardados localmente.
- **PREGUNTA:** no cuentan los "?" dentro de enlaces (`youtube.com/watch?v=…`). Cuenta como mención el canal o la cuenta del streamer y los apodos de la configuración: palabra completa, con o sin @, sin importar mayúsculas ni acentos ("Laló" = "lalo", pero "lalos" no cuenta).
- **Los mensajes del propio streamer nunca se marcan** como PREGUNTA.
- Las reglas se calculan en el backend para todas las plataformas. Los interruptores de la configuración solo deciden si la etiqueta se muestra.

**Mensajes resaltados en el chat:** además de su alerta, estos mensajes aparecen en la columna de chat con borde de 2 px y fondo teñido del color de su categoría, y una etiqueta de tipo:

| Mensaje | Etiqueta | Color |
|---|---|---|
| Mensaje con bits (Twitch) | ◆ N BITS | Dorado `#FDE047` |
| Mensaje destacado con puntos ("Destacar mi mensaje", Twitch) | ◎ DESTACADO | Naranja `#FB923C` |

### 3.4 Alertas por categoría

Las alertas se colorean por **categoría**, no por plataforma, para no chocar con los colores de plataforma. La etiqueta de plataforma indica el origen y el color del borde indica el tipo.

| Categoría | Color | Twitch | TikTok | YouTube | Kick |
|---|---|---|---|---|---|
| Seguidores | Azul claro `#93C5FD` | FOLLOW | FOLLOW · COMPARTIÓ | — | FOLLOW |
| Suscripción / membresía | Fucsia `#E879F9` | SUB (meses, nivel) · SUB REGALADA (cantidad, nivel) | — | MIEMBRO (nivel) | SUB |
| Dinero / regalos | Dorado `#FDE047` | BITS (+ mensaje) | REGALO (regalo × cantidad) | SUPER CHAT (monto + mensaje) | KICKS |
| Puntos del canal | Naranja `#FB923C` | PUNTOS (recompensa + costo) | — | — | — |
| Raid | Rosa `#F9A8D4` | RAID (canal + espectadores) | — | — | — |

Cada alerta muestra: etiqueta de plataforma, etiqueta de tipo con icono, hora, texto principal y, si existe, un detalle (mensaje, meses, nivel o costo).

Las subs regaladas se muestran como **una sola alerta de quien regala** ("X regaló 5 subs"), no una por cada persona que la recibe.

### 3.5 Paleta base

| Uso | Color |
|---|---|
| Fondo de ventana | `#0F1115` |
| Cabecera y pie | `#151821` |
| Panel de alertas | `#12141A` |
| Bordes y divisores | `#262A33` |
| Texto principal | `#E8EAED` / `#F3F4F6` |
| Texto secundario | `#A1A8B3` |
| Conectado | `#34D399` |

Tamaños de texto: mensaje 17 px, nombre 14 px, alertas 15 px, etiquetas 10–11 px.

En la cabecera del chat hay un botón de engrane que abre la pantalla de configuración.

### 3.6 Pantalla de configuración

Misma ventana (860 × 820 px), con botón para volver al chat y la versión de la app en la cabecera. Secciones:

**Conexiones** (tarjetas en cuadrícula de 2 × 2, cada una con los colores de su plataforma). Todas tienen un interruptor para activar o desactivar la plataforma sin cerrar sesión e indicador de estado (conectado / sin conectar).

| Plataforma | Contenido de la tarjeta |
|---|---|
| Twitch | Sin sesión: campo **Canal** (chat anónimo) y botón **Iniciar sesión con Twitch**. Esperando: el código que debe aparecer en la página de Twitch, **Abrir la página otra vez** y **Cancelar**. Con sesión: canal conectado, qué se recibe (chat, follows, subs, bits, puntos, raids), estado de las alertas y botón **Desconectar** |
| TikTok | Campo **Usuario de TikTok** y campo **Clave de Euler Stream** (oculta) |
| YouTube | Sin conectar: texto explicando que se abrirá el navegador y botón **Conectar con YouTube**. Conectado: canal, qué se recibe y botón **Desconectar** |
| Kick | Canal conectado, qué se recibe (chat, follows, subs, Kicks), botón **Desconectar** |

Nota visible: cada persona conecta sus propias cuentas y los datos de sesión se guardan solo en esa PC.

**Ventana**

- Siempre encima (interruptor).
- Iniciar con Windows (interruptor).
- Tamaño de texto: Normal / Grande / Muy grande.
- Panel de alertas: Izquierda / Derecha (por defecto, derecha).
- Opacidad de la ventana (deslizador).

"Siempre encima", "Iniciar con Windows" y la opacidad se guardan ya, pero se aplican al empaquetar con Electron (fase 5).

Los cambios se guardan solos (sin botón de guardar) y se aplican al momento en todas las ventanas abiertas, incluido el dock de OBS.

**Etiquetas del chat**

- Marcar NUEVO (interruptor).
- Marcar PREGUNTA (interruptor).
- Nombres o apodos que cuentan como mención (lista separada por comas).

**Dock de OBS (opcional) y actualizaciones**

- Dirección local para pegar en OBS → Docks → Docks de navegador personalizados (por ejemplo `http://localhost:4848/chat`), con botón **Copiar**.
- Actualizar automáticamente (interruptor).

## 4. Integración por plataforma

| Plataforma | Chat | Alertas | Autenticación | Estabilidad |
|---|---|---|---|---|
| Twitch | IRC (`tmi.js`) | EventSub por WebSocket | OAuth con botón | Oficial, estable |
| TikTok | `tiktok-live-connector` | Misma librería (follows y regalos) | Solo nombre de usuario | No oficial, frágil |
| YouTube | API oficial, `liveChatMessages.streamList` | Super Chats y membresías llegan en el mismo flujo | OAuth de Google con botón | Oficial, con cuota |
| Kick | WebSocket de Pusher | Pusher, o webhooks oficiales | OAuth con botón | Semi-oficial |

### 4.1 Twitch

- **Chat:** IRC con `tmi.js`, lectura anónima (sin token). El tag `first-msg` indica si es el primer mensaje del usuario en el canal → etiqueta **NUEVO** sin lógica extra.
  - Emotes: el tag `emotes` da las posiciones de cada emote (en caracteres Unicode); se parte el mensaje en texto e imágenes de `static-cdn.jtvnw.net`.
  - Mensajes con bits: tmi.js los entrega por el evento `cheer` (no por `message`); van al chat resaltados.
  - Mensajes destacados con puntos: llegan con `msg-id = highlighted-message`; van al chat resaltados.
- **Alertas:** EventSub (WebSocket) para follows (`channel.follow` v2), subs (`channel.subscribe`), resubs con mensaje (`channel.subscription.message`), subs regaladas (`channel.subscription.gift`), bits (`channel.cheer`), canjes de recompensas personalizadas y raids (`channel.raid`). Reconexión automática, migración cuando Twitch la pide (`session_reconnect`), vigilancia del keepalive y descarte de notificaciones repetidas.
- **Login:** app **pública** registrada en la consola de desarrolladores de Twitch (Client ID en `.env` como `TWITCH_CLIENT_ID`; no hay secreto). Flujo **Device Code**: el botón abre la página de Twitch con un código, el usuario autoriza y la app recibe el token sin necesidad de redirección. Permisos: `moderator:read:followers`, `channel:read:subscriptions`, `bits:read`, `channel:read:redemptions` (las raids no necesitan permiso).
- **Sesión:** se guarda en `twitch-session.json`, aparte de la configuración, y nunca se manda a la interfaz. El token se renueva antes de caducar (cada refresh token se usa una sola vez y se guarda el nuevo) y se valida cada hora, como exige Twitch. **Desconectar** revoca el token.
- **Canal:** con sesión iniciada, el chat usa el canal de la cuenta.
- **Notas:** los follows requieren permiso de moderador o dueño del canal (se cubre al autorizar con la cuenta propia). Solo se detectan canjes de recompensas personalizadas.

### 4.2 TikTok

- **Chat y alertas:** `tiktok-live-connector` (Node). Recibe comentarios, follows y regalos.
- **Login:** no se necesita para leer el chat propio; basta con el nombre de usuario, guardado una vez.
- **NUEVO:** TikTok no lo indica; se calcula guardando localmente los usuarios ya vistos (`seen-users.json`). La primera vez que se usa la app, todos los que escriban salen como NUEVO; desde ahí, solo quien nunca había escrito.
- **Regalos en combo:** agrupar los eventos y mostrar solo el total cuando termina el combo (`repeatEnd`).
- **Compartidos:** alerta "X compartió el live" (categoría Seguidores). Los reposts cuentan igual y salen como "X reposteó el live". Likes y entradas al live no se muestran: llenarían el panel.
- **Nombres:** se muestra el nombre visible (`nickname`); el @usuario (`displayId`) se guarda aparte para reconocer los mensajes del propio streamer.
- **Euler gratuito:** 2,500 peticiones de firma al día; solo cuenta conectar, no los mensajes. No usar `enableExtendedGiftInfo`, que es del plan de pago. Sin live, la app reintenta con espera creciente (de 30 s a 5 min) para no gastar el límite.
- **Riesgos:** depende de un servicio interno de TikTok y del servidor de firma de Euler Stream. Puede dejar de funcionar sin cambios de nuestro lado. Usar una API key gratuita de Euler y reconexión automática.
- **Nota:** apps como Meld ofrecen login con TikTok porque tienen acceso como socio; ese acceso no está disponible para desarrolladores individuales.

### 4.3 YouTube

- **Chat:** API oficial con `liveChatMessages.streamList`, conexión abierta de baja latencia.
- **Alertas:** Super Chats y membresías llegan como tipos de mensaje especiales.
- **Login:** OAuth de Google con botón (cliente de tipo "App de escritorio").
- **Cuota:** 10,000 unidades diarias por defecto; cada llamada a `streamList` cuesta 5 unidades. Evitar reconexiones en bucle.
- **Evitar reconectar cada 7 días:** en estado "Testing" los refresh tokens caducan a los 7 días. Pasar la pantalla de consentimiento a estado **"In production"** sin solicitar verificación: los tokens dejan de caducar (salvo que se revoquen o pasen unos 6 meses sin uso). La app sin verificar admite hasta 100 usuarios, de sobra para dos personas. A cambio, al conectar por primera vez Google muestra el aviso de "app no verificada": se acepta con **Configuración avanzada → Ir a la app**. Solo se hace una vez.

### 4.4 Kick

- **Chat y alertas:** conexión directa al WebSocket de Pusher (no requiere URL pública).
- **Alternativa oficial:** API pública con OAuth 2.1 + PKCE y eventos por webhooks, pero requiere una URL pública (no práctico en escritorio).
- **Login:** OAuth con botón.

## 5. Arquitectura propuesta

```
┌────────────┐
│  Twitch    │──┐
├────────────┤  │     ┌─────────────────┐      ┌──────────────────┐
│  TikTok    │──┤     │  Backend Node   │      │  Ventana (UI)    │
├────────────┤  ├────▶│  - conectores   │─────▶│  Electron        │
│  YouTube   │──┤     │  - normalizador │  WS  │  chat + alertas  │
├────────────┤  │     │  - reglas       │      │                  │
│  Kick      │──┘     └─────────────────┘      └──────────────────┘
└────────────┘
```

- **Un conector por plataforma:** cada uno se conecta, se reconecta solo y traduce sus eventos al formato común. Agregar una plataforma nueva = escribir un conector nuevo, sin tocar el resto.
- **Normalizador y reglas:** aplica las etiquetas NUEVO y PREGUNTA, agrupa combos de regalos y separa chat de alertas.
- **UI:** interfaz web servida en `localhost`. Se muestra en la ventana flotante de Electron (modo principal) y, opcionalmente, en un dock de OBS con la misma URL. Recibe los eventos por WebSocket local.
- **Almacenamiento local:** tokens de sesión, usuario de TikTok, clave de Euler, preferencias y lista de usuarios ya vistos. Cada PC tiene los suyos.

### 5.1 Formato común de evento

```json
{
  "id": "uuid",
  "platform": "twitch | tiktok | youtube | kick",
  "type": "chat | follow | sub | giftsub | member | bits | superchat | kicks | gift | reward | raid | share",
  "user": {
    "id": "123",
    "name": "lalo_gamer",
    "avatar": "https://..."
  },
  "text": "¡Buenas! ¿Qué juego toca hoy?",
  "detail": "Nivel 1",
  "amount": 500,
  "flags": {
    "firstTime": false,
    "question": true
  },
  "timestamp": "2026-10-26T21:02:00Z"
}
```

- `type: "chat"` va a la columna de chat; cualquier otro tipo va al panel de alertas.
- `detail` y `amount` son opcionales según el tipo de alerta (la tabla de qué lleva cada tipo está en `src/core/event.ts`).
- `giftsub` (subs regaladas) y `raid` se agregaron durante la fase de Twitch; `share` (compartidos de TikTok), en la fase 2.
- `user.login`: nombre de usuario único (login de Twitch, @usuario de TikTok), aparte del nombre visible.
- Campos opcionales de los mensajes de chat:
  - `fragments`: el texto partido en trozos `{ "type": "text", "text" }` o `{ "type": "emote", "name", "url" }` cuando lleva emotes. Si falta, se muestra `text`.
  - `highlight`: `"bits"` (con `amount` = bits) o `"highlighted"` (destacado con puntos) para resaltar el mensaje.
- En el código el tipo se llama `ChatEvent`, para no chocar con el `Event` del navegador.

### 5.2 Por qué app local y no web ni plugin de OBS

- **Web alojada:** `tiktok-live-connector` no funciona en el navegador; obligaría a mantener un servidor en internet con los tokens de ambos.
- **Plugin nativo de OBS:** requiere C/C++, solo funcionaría con OBS abierto y no sirve con TikTok LIVE Studio.
- **App local (elegida):** todo corre en la PC del usuario, el login con botón redirige a `localhost`, no hay costo de servidor y la misma interfaz sirve como ventana flotante o como dock de OBS.

## 6. Distribución y empaquetado

- **Electron + `electron-builder`:** genera un instalador `.exe` que incluye Node, el backend, la interfaz y las librerías. No hay que instalar nada manualmente. Tamaño aproximado: 100 MB.
- **Ventana flotante:** siempre encima, icono en la bandeja del sistema, arranque con Windows opcional.
- **Cuentas separadas:** cada usuario conecta sus cuentas desde la pantalla de configuración; los tokens se guardan localmente.
- **Sin secretos en el instalador:** un `.exe` de Electron se puede abrir y leer. Usar flujos para apps públicas: PKCE o Device Code en Twitch, PKCE en Kick, cliente de escritorio en Google. Los Client ID sí pueden ir incluidos.
- **Clave de Euler:** cada usuario usa la suya (gratuita) para no compartir el mismo límite.
- **Aviso de Windows SmartScreen:** sin firma digital, la primera instalación muestra un aviso; se acepta con **Más información → Ejecutar de todas formas**.
- **Actualizaciones automáticas:** `electron-updater` con releases de GitHub; al publicar una versión nueva, las dos instalaciones se actualizan solas.

## 7. Plan de desarrollo

Proyecto en **TypeScript**. Se trabaja **una plataforma a la vez**, en este orden: Twitch → TikTok → YouTube → Kick. No se empieza la siguiente hasta terminar la actual.

1. **Twitch** (también sienta la base común) — **terminada**:
   1. Proyecto en TypeScript y script que imprima en consola el chat de Twitch (lectura anónima con `tmi.js`). ✔
   2. Conector de Twitch con el formato de evento de la sección 5.1. ✔
   3. Interfaz en `localhost`: chat, panel de alertas, colores y filtros, usable ya desde el navegador. ✔
   4. Pantalla de configuración y almacenamiento local de cuentas y preferencias. ✔
   5. Login con botón y alertas por EventSub. ✔
   6. Reglas NUEVO y PREGUNTA. ✔
   7. Extras: logos de plataforma, emotes de Twitch, raids, subs regaladas, mensajes con bits y destacados en el chat, lado del panel de alertas configurable. ✔
   - Pendiente: emotes de 7TV, BTTV y FFZ.
2. **TikTok:** conector con `tiktok-live-connector` (chat, follows y regalos), NUEVO por usuarios ya vistos, agrupación de combos de regalos y tarjeta de configuración.
3. **YouTube:** login con Google, chat con `streamList`, Super Chats y membresías.
4. **Kick:** login con PKCE, chat y alertas por Pusher.
5. **Empaquetado con Electron:** ventana flotante, bandeja, instalador y actualizaciones automáticas.

## 8. Riesgos y consideraciones

- **TikTok** es la integración más frágil; la UI debe mostrar claramente el estado de conexión y reconectar sola.
- **YouTube** tiene cuota diaria; controlar reconexiones. Mantener el proyecto de Google en "In production" para que las sesiones no caduquen cada 7 días.
- **Kick** por Pusher no es la API oficial documentada; puede cambiar.
- La configuración inicial de OAuth (Twitch, Google, Kick) es lo más tedioso, pero se hace una sola vez.
- Las integraciones no oficiales pueden quedar en una zona gris respecto a los términos de cada plataforma.
