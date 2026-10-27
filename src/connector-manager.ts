// Gestor de conectores: según la configuración, enciende, apaga o recrea el conector
// de cada plataforma, y reenvía sus eventos y estados al servidor local.

import type { Config } from "./core/config.ts";
import type { Connector } from "./core/connector.ts";
import { PLATFORMS, type Platform } from "./core/event.ts";
import { STATUS_TEXT } from "./core/protocol.ts";
import { DemoConnector } from "./connectors/demo.ts";
import { TwitchConnector } from "./connectors/twitch.ts";
import type { LocalServer } from "./server.ts";

interface Wanted {
  /** Identifica la configuración del conector: si cambia, se recrea. */
  key: string;
  create: () => Connector;
}

export class ConnectorManager {
  readonly #server: LocalServer;
  readonly #demoMode: boolean;
  readonly #active = new Map<Platform, { key: string; connector: Connector }>();
  #queue: Promise<void> = Promise.resolve();

  constructor(server: LocalServer, demoMode: boolean) {
    this.#server = server;
    this.#demoMode = demoMode;
  }

  /** Ajusta los conectores a la configuración. Las llamadas se aplican en orden. */
  apply(config: Config): Promise<void> {
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

  #wanted(platform: Platform, config: Config): Wanted | undefined {
    if (!config.platforms[platform].enabled) return undefined;

    const channel = config.platforms.twitch.channel;
    if (platform === "twitch" && channel) return { key: `twitch:${channel}`, create: () => new TwitchConnector(channel) };

    // TikTok, YouTube y Kick llegan en sus fases. Mientras, en modo demo se simulan.
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
    connector.on("event", (event) => this.#server.publishEvent(event));
    this.#active.set(platform, { key: wanted.key, connector });
    void connector.connect();
  }
}
