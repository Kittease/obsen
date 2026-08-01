import type ObsenPlugin from "../../src/main.ts";

/**
 * Types the plugin instance `executeObsidian` hands the specs, so a spec that reaches
 * into `plugins.obsen.ports` is checked against the real plugin rather than `any`.
 */
declare module "wdio-obsidian-service" {
	interface InstalledPlugins {
		obsen: ObsenPlugin;
	}
}
