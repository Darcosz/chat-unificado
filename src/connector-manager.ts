// Gestor de conectores: según la configuración, enciende, apaga o recrea el conector
// de cada plataforma, aplica las reglas (NUEVO, PREGUNTA) a sus eventos y los reenvía,
// junto con su estado, al servidor local.

import type { Config } from "./core/config.ts";
import type { Connector } from "./core/connector.ts";
import { PLATFORMS, type Platform } from "./core/event.ts";
import { STATUS_TEXT } from "./core/protocol.ts";
import { applyRules, type RuleContext } from "./core/rules.ts";
import { DemoConnector } from "./connectors/demo.ts";
import { TikTokConnector } from "./connectors/tiktok.ts";
import { TwitchConnector, type TwitchAlertsOptions } from "./connectors/twitch.ts";
import { YouTubeConnector } from "./connectors/youtube.ts";
import type { SeenUsers } from "./seen-users.ts";
import type { LocalServer } from "./server.ts";
import type { TwitchAuth } from "./twitch/auth.ts";
import type { GoogleAuth } from "./youtube/auth.ts";

interface Wanted {
  /** Identifica la configuración del conector: si cambia, se recrea. */
  key: string;
  create: () => Connector;
}

export class ConnectorManager {
  readonly #server: LocalServer;
  readonly #demoMode: boolean;
  readonly #twitchAuth: TwitchAuth;
  readonly #onTwitchAlertsStatus: TwitchAlertsOptions["onStatus"];
  readonly #seenUsers: SeenUsers;
  readonly #googleAuth: GoogleAuth;
  readonly #active = new Map<Platform, { key: string; connector: Connector }>();
  #queue: Promise<void> = Promise.resolve();
  #rules: RuleContext = { mentionNames: [], ownNames: [] };

  constructor(options: {
    server: LocalServer;
    demoMode: boolean;
    twitchAuth: TwitchAuth;
    onTwitchAlertsStatus: TwitchAlertsOptions["onStatus"];
    seenUsers: SeenUsers;
    googleAuth: GoogleAuth;
  }) {
    this.#googleAuth = options.googleAuth;
    this.#server = options.server;
    this.#demoMode = options.demoMode;
    this.#twitchAuth = options.twitchAuth;
    this.#onTwitchAlertsStatus = options.onTwitchAlertsStatus;
    this.#seenUsers = options.seenUsers;
  }

  /** Ajusta los conectores a la configuración. Las llamadas se aplican en orden. */
  apply(config: Config): Promise<void> {
    this.#rules = this.#ruleContext(config);
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      for (const platform of PLATFORMS) await this.#applyPlatform(platform, this.#wanted(platform, config));
    });
    return this.#queue;
  }

  close(): Promise<void> {
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      for (const platform of PLATFORMS) await this.#applyPlatform(platform, undefined);
    });
    return this.#queue;
  }

  /** Nombres del streamer en cada plataforma, más los apodos de la configuración. */
  #ruleContext(config: Config): RuleContext {
    const account = this.#twitchAuth.account;
    const ownNames = [
      config.platforms.twitch.channel,
      account?.login ?? "",
      account?.displayName ?? "",
      config.platforms.tiktok.username,
      this.#googleAuth.account?.title ?? "",
    ].filter(Boolean);
    return { ownNames, mentionNames: [...ownNames, ...config.tags.mentions] };
  }

  #wanted(platform: Platform, config: Config): Wanted | undefined {
    if (!config.platforms[platform].enabled) return undefined;

    const channel = config.platforms.twitch.channel;
    if (platform === "twitch" && channel) {
      // Con sesión iniciada también llegan las alertas; si cambia la cuenta, se recrea.
      const account = this.#twitchAuth.account;
      const alerts = account ? { auth: this.#twitchAuth, userId: account.userId, onStatus: this.#onTwitchAlertsStatus } : undefined;
      return { key: `twitch:${channel}:${account?.userId ?? "anónimo"}`, create: () => new TwitchConnector(channel, alerts) };
    }

    const { username, eulerKey } = config.platforms.tiktok;
    if (platform === "tiktok" && username) {
      // La clave forma parte de la llave: si se cambia, se reconecta con la nueva.
      return { key: `tiktok:${username}:${eulerKey}`, create: () => new TikTokConnector(username, eulerKey) };
    }

    const youtubeAccount = this.#googleAuth.account;
    if (platform === "youtube" && youtubeAccount) {
      return { key: `youtube:${youtubeAccount.channelId}`, create: () => new YouTubeConnector(this.#googleAuth) };
    }

    // Kick llega en su fase. Mientras, en modo demo se simula (igual que las plataformas sin cuenta).
    if (this.#demoMode) return { key: "demo", create: () => new DemoConnector(platform) };
    return undefined;
  }

  async #applyPlatform(platform: Platform, wanted: Wanted | undefined): Promise<void> {
    const current = this.#active.get(platform);
    if (current?.key === wanted?.key) return;

    if (current) {
      await current.connector.disconnect();
      current.connector.removeAllListeners();
      this.#active.delete(platform);
    }

    if (!wanted) {
      this.#server.publishStatus(platform, "disconnected");
      return;
    }

    const connector = wanted.create();
    connector.on("status", (status, detail) => {
      this.#server.publishStatus(platform, status, detail);
      console.log(`[${platform}] ${STATUS_TEXT[status]}${detail ? `: ${detail}` : ""}`);
    });
    connector.on("event", (event) => {
      // Si la plataforma no indica NUEVO, se calcula con los usuarios ya vistos.
      if (event.type === "chat" && !connector.reportsFirstTime) {
        event = { ...event, flags: { ...event.flags, firstTime: this.#seenUsers.markSeen(platform, event.user.id) } };
      }
      this.#server.publishEvent(applyRules(event, this.#rules));
    });
    this.#active.set(platform, { key: wanted.key, connector });
    void connector.connect();
  }
}
