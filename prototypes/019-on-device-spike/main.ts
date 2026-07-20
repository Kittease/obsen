/*
 * OBSEN SPIKE — THROWAWAY PROTOTYPE (wayfinder ticket 019). Not production code.
 * Proves the @filen/sdk browser build works on-device inside Obsidian:
 * login, list, E2EE upload/download round-trip, visibilitychange, transfer perf.
 * Everything is logged to obsen-spike-log.md at the vault root.
 */
import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, normalizePath } from "obsidian"
import FilenSDK from "@filen/sdk"

const REMOTE_DIR = "/obsen-spike"
const LOG_NOTE = "obsen-spike-log.md"
const UPLOAD_NOTE = "obsen-spike-upload.md"
const DOWNLOAD_NOTE = "obsen-spike-download.md"
const TRANSFER_NAME = "obsen-spike-transfer.bin"
const TRANSFER_SIZE = 8 * 1024 * 1024

interface SpikeData {
	email: string
	authConfig: Record<string, unknown> | null
}

const DEFAULT_DATA: SpikeData = { email: "", authConfig: null }

function platformLabel(): string {
	if (Platform.isIosApp) return "iOS"
	if (Platform.isAndroidApp) return "Android"
	return Platform.isMobile ? "mobile" : "desktop"
}

function mem(): string {
	const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
	if (!m) return "heap n/a"
	return `heap ${(m.usedJSHeapSize / 1048576).toFixed(1)}/${(m.jsHeapSizeLimit / 1048576).toFixed(0)} MiB`
}

function ms(t0: number): string {
	return `${Math.round(performance.now() - t0)} ms`
}

function errStr(e: unknown): string {
	return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
	return true
}

export default class ObsenSpikePlugin extends Plugin {
	data: SpikeData = DEFAULT_DATA
	sdk: FilenSDK = new FilenSDK()
	password = ""
	twoFactor = ""

	async onload() {
		this.data = Object.assign({}, DEFAULT_DATA, await this.loadData())
		if (this.data.authConfig) {
			try {
				this.sdk.init(this.data.authConfig as never)
			} catch (e) {
				console.error("[obsen-spike] auth restore failed", e)
				this.data.authConfig = null
			}
		}
		this.addSettingTab(new SpikeSettingTab(this.app, this))
		this.addCommand({ id: "run", name: "Run spike (list + round-trip)", callback: () => void this.runSpike() })
		this.addCommand({ id: "transfer-test", name: `Transfer test (${TRANSFER_SIZE / 1048576} MiB)`, callback: () => void this.transferTest() })
		this.registerDomEvent(document, "visibilitychange", () => {
			new Notice(`spike: visibility → ${document.visibilityState}`)
			void this.log(`visibilitychange → ${document.visibilityState}`)
		})
		void this.log(`plugin loaded on ${platformLabel()} — ${this.loggedIn() ? "auth restored from data.json" : "not logged in"} — ${mem()}`)
	}

	loggedIn(): boolean {
		return !!(this.sdk as unknown as { config?: { apiKey?: string } }).config?.apiKey
	}

	async log(msg: string) {
		const line = `${new Date().toISOString()} [${platformLabel()}] ${msg}`
		console.log("[obsen-spike]", line)
		try {
			const path = normalizePath(LOG_NOTE)
			const adapter = this.app.vault.adapter
			if (!(await adapter.exists(path))) await adapter.write(path, "# obsen spike log\n\n")
			await adapter.append(path, `- \`${line}\`\n`)
		} catch (e) {
			console.error("[obsen-spike] could not write log note", e)
		}
	}

	async login() {
		if (!this.data.email || !this.password) {
			new Notice("spike: email and password required")
			return
		}
		new Notice("spike: logging in…")
		const t0 = performance.now()
		try {
			const sdk = new FilenSDK()
			await sdk.login({
				email: this.data.email,
				password: this.password,
				twoFactorCode: this.twoFactor || undefined
			})
			const cfg = { ...(sdk as unknown as { config: Record<string, unknown> }).config }
			delete cfg.password
			delete cfg.twoFactorCode
			delete cfg.axiosInstance
			this.sdk = sdk
			this.data.authConfig = cfg
			await this.saveData(this.data)
			await this.log(`login OK in ${ms(t0)} — auth config persisted to data.json (plaintext, spike only)`)
			new Notice("spike: logged in ✅")
		} catch (e) {
			await this.log(`LOGIN FAILED after ${ms(t0)}: ${errStr(e)}`)
			new Notice("spike: login FAILED — see log note")
		}
	}

	async logout() {
		this.data.authConfig = null
		await this.saveData(this.data)
		this.sdk = new FilenSDK()
		await this.log("logged out — saved auth config cleared")
		new Notice("spike: logged out")
	}

	async remoteDirUUID(): Promise<string> {
		try {
			return await this.sdk.fs().mkdir({ path: REMOTE_DIR })
		} catch {
			const uuid = await this.sdk.fs().pathToItemUUID({ path: REMOTE_DIR })
			if (!uuid) throw new Error(`could not create or resolve ${REMOTE_DIR}`)
			return uuid
		}
	}

	async runSpike() {
		if (!this.loggedIn()) {
			new Notice("spike: log in first (settings tab)")
			return
		}
		try {
			await this.log(`── spike run start — ${mem()}`)

			let t0 = performance.now()
			const entries = await this.sdk.fs().readdir({ path: "/" })
			const preview = entries.slice(0, 15).join(", ") + (entries.length > 15 ? ", …" : "")
			await this.log(`list /: ${entries.length} entries in ${ms(t0)} [${preview}]`)

			const dirUUID = await this.remoteDirUUID()

			const content = `spike upload from ${platformLabel()} at ${new Date().toISOString()}\n`
			const path = normalizePath(UPLOAD_NOTE)
			let file = this.app.vault.getFileByPath(path)
			if (file) await this.app.vault.modify(file, content)
			else file = await this.app.vault.create(path, content)
			const bytes = await this.app.vault.readBinary(file)

			t0 = performance.now()
			await this.sdk.cloud().uploadWebFile({
				file: new File([bytes], UPLOAD_NOTE, { lastModified: Date.now() }),
				parent: dirUUID
			})
			await this.log(`upload ${UPLOAD_NOTE} (${bytes.byteLength} B) in ${ms(t0)}`)

			t0 = performance.now()
			const remote = await this.sdk.fs().readFile({ path: `${REMOTE_DIR}/${UPLOAD_NOTE}` })
			const match = sameBytes(new Uint8Array(bytes), new Uint8Array(remote))
			await this.log(`download ${UPLOAD_NOTE} (${remote.byteLength} B) in ${ms(t0)} — content ${match ? "MATCHES ✅" : "MISMATCH ❌"}`)

			await this.writeVaultBinary(DOWNLOAD_NOTE, new Uint8Array(remote))
			await this.log(`wrote remote copy into vault as ${DOWNLOAD_NOTE} — ${mem()}`)
			await this.log("── spike run done")
			new Notice(`spike: run complete ${match ? "✅" : "❌"} — see ${LOG_NOTE}`)
		} catch (e) {
			await this.log(`SPIKE RUN FAILED: ${errStr(e)}`)
			console.error("[obsen-spike]", e)
			new Notice("spike: run FAILED — see log note")
		}
	}

	async transferTest() {
		if (!this.loggedIn()) {
			new Notice("spike: log in first (settings tab)")
			return
		}
		try {
			await this.log(`── transfer test start (${TRANSFER_SIZE / 1048576} MiB random) — ${mem()}`)
			const data = new Uint8Array(TRANSFER_SIZE)
			for (let off = 0; off < TRANSFER_SIZE; off += 65536) {
				crypto.getRandomValues(data.subarray(off, Math.min(off + 65536, TRANSFER_SIZE)))
			}
			const dirUUID = await this.remoteDirUUID()

			let t0 = performance.now()
			await this.sdk.cloud().uploadWebFile({
				file: new File([data], TRANSFER_NAME, { lastModified: Date.now() }),
				parent: dirUUID
			})
			await this.log(`upload ${TRANSFER_NAME} in ${ms(t0)} — ${mem()}`)

			t0 = performance.now()
			const back = await this.sdk.fs().readFile({ path: `${REMOTE_DIR}/${TRANSFER_NAME}` })
			const match = sameBytes(data, new Uint8Array(back))
			await this.log(`download ${TRANSFER_NAME} in ${ms(t0)} — content ${match ? "MATCHES ✅" : "MISMATCH ❌"} — ${mem()}`)
			await this.log("── transfer test done")
			new Notice(`spike: transfer test ${match ? "✅" : "❌"} — see ${LOG_NOTE}`)
		} catch (e) {
			await this.log(`TRANSFER TEST FAILED: ${errStr(e)}`)
			console.error("[obsen-spike]", e)
			new Notice("spike: transfer test FAILED — see log note")
		}
	}

	async writeVaultBinary(name: string, data: Uint8Array) {
		const path = normalizePath(name)
		const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
		const existing = this.app.vault.getFileByPath(path)
		if (existing) await this.app.vault.modifyBinary(existing, buf)
		else await this.app.vault.createBinary(path, buf)
	}
}

class SpikeSettingTab extends PluginSettingTab {
	plugin: ObsenSpikePlugin

	constructor(app: App, plugin: ObsenSpikePlugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display() {
		const { containerEl } = this
		containerEl.empty()

		containerEl.createEl("p", {
			text: "Throwaway spike (Obsen ticket 019). Credentials go only to Filen; the derived auth config is stored in plaintext plugin data — use a test account and a test vault."
		})
		containerEl.createEl("p", {
			text: `Status: ${this.plugin.loggedIn() ? "logged in ✅" : "not logged in"} — results land in ${LOG_NOTE}`
		})

		new Setting(containerEl)
			.setName("Filen email")
			.addText(t =>
				t.setValue(this.plugin.data.email).onChange(async v => {
					this.plugin.data.email = v.trim()
					await this.plugin.saveData(this.plugin.data)
				})
			)

		new Setting(containerEl)
			.setName("Password")
			.setDesc("Kept in memory only, never saved.")
			.addText(t => {
				t.inputEl.type = "password"
				t.onChange(v => (this.plugin.password = v))
			})

		new Setting(containerEl)
			.setName("2FA code")
			.setDesc("Only if enabled on the account.")
			.addText(t => t.onChange(v => (this.plugin.twoFactor = v.trim())))

		new Setting(containerEl)
			.setName("Log in")
			.addButton(b =>
				b.setButtonText("Log in").setCta().onClick(async () => {
					await this.plugin.login()
					this.display()
				})
			)

		new Setting(containerEl)
			.setName("Run spike")
			.setDesc("List remote root, upload a note, download it back, byte-compare.")
			.addButton(b => b.setButtonText("Run").onClick(() => void this.plugin.runSpike()))

		new Setting(containerEl)
			.setName("Transfer test")
			.setDesc(`Round-trip ${TRANSFER_SIZE / 1048576} MiB of random data, log timing and memory.`)
			.addButton(b => b.setButtonText("Run").onClick(() => void this.plugin.transferTest()))

		new Setting(containerEl)
			.setName("Log out")
			.setDesc("Clear the saved auth config.")
			.addButton(b =>
				b.setButtonText("Log out").setWarning().onClick(async () => {
					await this.plugin.logout()
					this.display()
				})
			)
	}
}
