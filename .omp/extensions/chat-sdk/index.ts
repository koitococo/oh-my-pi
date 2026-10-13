import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { config, SlackInteractions } from "./transport";

export default function slackInteractions(pi: ExtensionAPI) {
	if (typeof pi.hasCapability !== "function" || !pi.hasCapability("interaction-requests")) return;

	let context: ExtensionContext;
	let transport: SlackInteractions | undefined;
	let server: Bun.Server<undefined> | undefined;
	let warned = false;
	const warn = () => {
		if (!warned && context?.hasUI) {
			warned = true;
			context.ui.notify("Slack interactions unavailable; continue in the native TUI.", "warning");
		}
	};
	// Subscribe before querying startup snapshots. The transport deduplicates revision identities.
	pi.on("interaction_request", (event, ctx) => {
		context = ctx;
		if (event.change === "closed") transport?.close(event.request, event.reason);
		else transport?.publish(event.request);
	});
	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		if (!transport) {
			const settings = config(process.env);
			if (!settings) {
				warn();
				return;
			}
			const candidate = new SlackInteractions(settings, () => context, warn);
			try {
				await candidate.start();
				server = Bun.serve({
					hostname: settings.hostname,
					port: settings.port,
					fetch: request => candidate.webhook(request),
				});
				transport = candidate;
			} catch {
				await candidate.stop().catch(() => {});
				warn();
				return;
			}
		}
		for (const request of ctx.getPendingInteractions()) transport.publish(request);
	});
	pi.on("session_shutdown", async () => {
		server?.stop();
		server = undefined;
		await transport?.stop();
		transport = undefined;
	});
}
