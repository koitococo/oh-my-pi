import { randomUUID } from "node:crypto";
import { Chat, type Logger, type ModalResponse, type SentMessage } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import type {
	ExtensionContext,
	InteractionActionId,
	InteractionResponse,
	PendingInteraction,
} from "@oh-my-pi/pi-coding-agent";
import { answer, card, chunks, fullText, modal, planFeedback, response, scopeKey } from "./render";

export interface Config {
	token: string;
	signingSecret: string;
	channel: string;
	users: Set<string>;
	hostname: string;
	port: number;
}
export function config(env: Record<string, string | undefined>): Config | undefined {
	const token = env.OMP_SLACK_BOT_TOKEN,
		signingSecret = env.OMP_SLACK_SIGNING_SECRET,
		channel = env.OMP_SLACK_CHANNEL;
	const users = new Set(
		(env.OMP_SLACK_USERS ?? "")
			.split(",")
			.map(s => s.trim())
			.filter(Boolean),
	);
	const port = Number(env.OMP_SLACK_PORT ?? "3218");
	if (!token || !signingSecret || !channel || !users.size || !Number.isInteger(port) || port < 1 || port > 65535)
		return undefined;
	return { token, signingSecret, channel, users, hostname: env.OMP_SLACK_HOST ?? "127.0.0.1", port };
}
interface Entry {
	request: PendingInteraction;
	token: string;
	message?: SentMessage;
	closed: boolean;
}
interface Form {
	entry: Entry;
	user: string;
	threadId: string;
	messageId: string;
	action: InteractionActionId;
	index: number;
	answers: NonNullable<InteractionResponse["answers"]>;
	viewId?: string;
}
export class SlackInteractions {
	readonly bot: Chat;
	private entries = new Map<string, Entry>();
	private tokens = new Map<string, Entry>();
	private forms = new Map<string, Form>();
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;
	private background = new Set<Promise<unknown>>();
	constructor(
		private settings: Config,
		private context: () => ExtensionContext,
		private warn: () => void,
		apiUrl?: string,
	) {
		// Drop SDK payload/error objects; only a generic TUI notification crosses this boundary.
		const logger: Logger = {
			child: () => logger,
			debug: () => {},
			info: () => {},
			warn: () => this.warn(),
			error: () => this.warn(),
		};
		this.bot = new Chat({
			userName: "omp",
			adapters: {
				slack: createSlackAdapter({
					botToken: settings.token,
					signingSecret: settings.signingSecret,
					apiUrl: apiUrl ?? "https://slack.com/api/",
					logger,
				}),
			},
			state: createMemoryState(),
			logger,
		});
		this.bot.onAction(async event => {
			const entry = this.tokens.get(event.value ?? "");
			if (!entry || !this.authorized(entry, event.user.userId, event.threadId, event.messageId)) return;
			const action = entry.request.actions.find(a => a.id === event.actionId && !a.disabled && !a.localRequired);
			if (!action) return;
			if (action.id === "cancel" || action.id === "ask.chat") {
				await this.submit(entry, response(entry.request, action.id));
				return;
			}
			const key = randomUUID();
			const form: Form = {
				entry,
				user: event.user.userId,
				threadId: event.threadId,
				messageId: event.messageId,
				action: action.id,
				index: 0,
				answers: [],
			};
			this.forms.set(key, form);
			try {
				const opened = await event.openModal(modal(entry.request, key, action.id));
				form.viewId = opened?.viewId;
				if (!opened) this.forms.delete(key);
			} catch {
				this.forms.delete(key);
				this.warn();
			}
		});
		this.bot.onModalSubmit("omp_response", async (event): Promise<ModalResponse> => {
			const key = event.privateMetadata ?? "",
				form = this.forms.get(key);
			if (
				!form ||
				form.user !== event.user.userId ||
				form.viewId !== event.viewId ||
				(event.relatedMessage && event.relatedMessage.id !== form.messageId) ||
				(event.relatedThread && event.relatedThread.id !== form.threadId) ||
				!this.authorized(form.entry, event.user.userId, form.threadId, form.messageId)
			)
				return { action: "clear" };
			// SDK consumes related-context storage on the FIRST submit, even validation errors.
			// Retain the association authenticated when opening the exact user-bound view.
			const r = form.entry.request;
			const reply = response(r, form.action);
			if (r.kind === "ask") {
				try {
					form.answers[form.index] = answer(r, form.index, event.values);
				} catch {
					return {
						action: "errors",
						errors: { selection: "Choose valid option numbers or enter a custom answer." },
					};
				}
				if (form.index + 1 < r.questions.length) {
					form.index++;
					const nextToken = randomUUID();
					this.forms.delete(key);
					this.forms.set(nextToken, form);
					return { action: "update", modal: modal(r, nextToken, form.action, form.index) };
				}
				reply.answers = form.answers;
			} else {
				reply.feedback = planFeedback(r.feedback, event.values.feedback);
				reply.modelId = event.values.model || r.selectedModelId;
				if (form.action === "plan.refine" && !reply.feedback?.trim())
					return { action: "errors", errors: { feedback: "Provide meaningful refinement feedback." } };
			}
			// Consume the modal capability before entering the core; a replay cannot execute twice.
			this.forms.delete(key);
			const result = await this.submit(form.entry, reply);
			if (result !== "accepted")
				await this.bot.thread(form.threadId).post(`OMP response: ${result}. Use the current card or native TUI.`);
			return { action: "clear" };
		});
	}
	authorized(entry: Entry, user: string, thread: string, message: string): boolean {
		return (
			!this.stopped &&
			!entry.closed &&
			this.settings.users.has(user) &&
			thread.split(":")[1] === this.settings.channel &&
			entry.message?.id === message &&
			this.context()
				.getPendingInteractions()
				.some(r => scopeKey(r) === scopeKey(entry.request) && r.revision === entry.request.revision)
		);
	}
	private async submit(entry: Entry, reply: InteractionResponse): Promise<string> {
		if (entry.closed) return "stale";
		// Core owns first-valid-wins, including simultaneous native responses.
		try {
			const result = await this.context().respondToInteraction(reply);
			if (result.status === "accepted" || result.status === "stale") this.close(entry.request, result.status);
			return result.status;
		} catch {
			this.warn();
			return "transport unavailable";
		}
	}
	publish(request: PendingInteraction): void {
		const old = this.entries.get(scopeKey(request));
		if (old && old.request.revision >= request.revision) return;
		if (old) this.close(old.request, "replaced");
		const entry: Entry = { request, token: randomUUID(), closed: false };
		this.entries.set(scopeKey(request), entry);
		this.tokens.set(entry.token, entry);
		this.enqueue(async () => {
			if (entry.closed || this.stopped) return;
			// Publish a non-actionable parent first. Never enable approval until ALL content is delivered.
			entry.message = await this.bot
				.channel(`slack:${this.settings.channel}`)
				.post("OMP interaction: publishing complete review content…");
			const thread = this.bot.thread(`slack:${this.settings.channel}:${entry.message.id}`);
			let text = fullText(request);
			if (request.kind === "plan_review")
				text += `\n\nModels:\n${request.models.map(m => `${m.id}: ${m.label}`).join("\n")}`;
			const parts = chunks(text);
			for (let i = 0; i < parts.length; i++)
				await thread.post({ raw: `Part ${i + 1}/${parts.length}\n${parts[i]}` });
			await entry.message.edit(
				entry.closed ? "OMP interaction closed; use current card or TUI." : card(request, entry.token),
			);
		});
	}
	close(request: PendingInteraction, reason = "closed"): void {
		const entry = this.entries.get(scopeKey(request));
		if (!entry || entry.request.revision !== request.revision) return;
		this.revoke(entry);
		this.entries.delete(scopeKey(request));
		this.enqueue(async () => {
			if (entry.message)
				await entry.message.edit(
					`OMP interaction ${reason === "accepted" ? "accepted (not execution completion)" : "closed"}. Native TUI is authoritative.`,
				);
		});
	}
	private revoke(entry: Entry) {
		entry.closed = true;
		this.tokens.delete(entry.token);
		for (const [key, form] of this.forms) if (form.entry === entry) this.forms.delete(key);
	}
	private enqueue(work: () => Promise<void>) {
		this.queue = this.queue.then(work).catch(() => {
			this.warn();
		});
	}
	async start() {
		await this.bot.initialize();
	}
	async flush() {
		await Promise.allSettled(this.background);
		await this.queue;
	}
	async stop() {
		this.stopped = true;
		for (const entry of this.entries.values()) this.close(entry.request);
		await this.queue;
		await this.bot.shutdown();
	}
	async webhook(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== "/api/webhooks/slack" || request.method !== "POST")
			return new Response("Not found", { status: 404 });
		try {
			return await this.bot.webhooks.slack(request, {
				waitUntil: task => {
					this.background.add(task);
					void task.finally(() => this.background.delete(task)).catch(() => this.warn());
				},
			});
		} catch {
			this.warn();
			return new Response("Unavailable", { status: 503 });
		}
	}
}
