import FilenSDK, { environment, type Environment } from "@filen/sdk";

/**
 * Constructs an unauthenticated Filen SDK.
 *
 * Cheap and offline: nothing here touches the network, which is why the plugin
 * may do it during `onload` (spec §1.3). Authentication is applied later by
 * re-`init`ing this instance with a stored Auth Config.
 */
export function createFilenSdk(): FilenSDK {
	return new FilenSDK();
}

/**
 * Which code paths the SDK will take at runtime. Must be `"browser"` everywhere
 * Obsen runs — the SDK decides this from the globals present, independently of
 * how the bundle was built, so it is worth asserting rather than assuming.
 */
export function sdkEnvironment(): Environment {
	return environment;
}
