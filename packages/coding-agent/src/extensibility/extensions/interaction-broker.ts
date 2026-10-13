import { randomUUID } from "node:crypto";
import type {
	InteractionRequestEvent,
	InteractionResponse,
	InteractionResponseResult,
	InteractionScope,
	PendingInteraction,
} from "./types";

export type InteractionPayload = PendingInteraction extends infer T
	? T extends PendingInteraction
		? Omit<T, keyof InteractionScope>
		: never
	: never;
export interface InteractionHandle {
	readonly request: PendingInteraction;
	update(payload: InteractionPayload): void;
	close(reason?: string): void;
	respond(response: Omit<InteractionResponse, keyof InteractionScope>): Promise<InteractionResponseResult>;
}
interface InteractionOptions {
	validate(response: InteractionResponse): string | undefined | Promise<string | undefined>;
	resolve(response: InteractionResponse): void;
	onClose?(reason: string): void;
}
interface RecordEntry {
	request: PendingInteraction;
	options: InteractionOptions;
}
const instanceId = randomUUID();

/** Owns native ask/plan decision capabilities; never performs the resulting agent work. */
export class InteractionBroker {
	readonly #records = new Map<string, RecordEntry>();
	constructor(
		private readonly sessionId: () => string,
		private readonly notify: (event: InteractionRequestEvent) => void,
	) {}

	getPendingInteractions(): PendingInteraction[] {
		this.#invalidateChangedSession();
		return Array.from(this.#records.values(), entry => structuredClone(entry.request));
	}

	open(payload: InteractionPayload, options: InteractionOptions): InteractionHandle {
		this.#invalidateChangedSession();
		const entry: RecordEntry = {
			request: {
				...structuredClone(payload),
				instanceId,
				sessionId: this.sessionId(),
				requestId: randomUUID(),
				revision: 1,
			},
			options,
		};
		this.#records.set(entry.request.requestId, entry);
		const broker = this;
		const handle: InteractionHandle = {
			get request() {
				return structuredClone(entry.request);
			},
			update(next) {
				if (!broker.#current(entry)) return;
				entry.request = {
					...structuredClone(next),
					instanceId,
					sessionId: entry.request.sessionId,
					requestId: entry.request.requestId,
					revision: entry.request.revision + 1,
				};
				broker.#publish(entry, "updated");
			},
			close(reason = "closed") {
				broker.#close(entry, reason);
			},
			respond(response) {
				const { instanceId, sessionId, requestId, revision } = entry.request;
				return broker.#respond({ ...response, instanceId, sessionId, requestId, revision });
			},
		};
		this.#publish(entry, "opened");
		return handle;
	}

	respondToInteraction(response: InteractionResponse): Promise<InteractionResponseResult> {
		try {
			return this.#respond(structuredClone(response));
		} catch {
			return Promise.resolve({ status: "invalid", message: "Response must be serializable." });
		}
	}

	closeAll(reason: string): void {
		for (const entry of Array.from(this.#records.values())) this.#close(entry, reason);
	}

	#current(entry: RecordEntry): boolean {
		return this.#records.get(entry.request.requestId) === entry && entry.request.sessionId === this.sessionId();
	}

	#invalidateChangedSession(): void {
		for (const entry of this.#records.values()) {
			if (entry.request.sessionId !== this.sessionId()) this.#close(entry, "session_changed");
		}
	}

	async #respond(response: InteractionResponse): Promise<InteractionResponseResult> {
		this.#invalidateChangedSession();
		if (!response || typeof response !== "object") return { status: "invalid" };
		const entry = this.#records.get(response.requestId);
		const matches = () =>
			!!entry &&
			this.#current(entry) &&
			response.instanceId === entry.request.instanceId &&
			response.sessionId === entry.request.sessionId &&
			response.revision === entry.request.revision;
		if (!matches() || !entry) return { status: "stale" };
		if (
			(response.feedback !== undefined && typeof response.feedback !== "string") ||
			(response.modelId !== undefined && typeof response.modelId !== "string") ||
			(response.answers !== undefined && !Array.isArray(response.answers))
		) {
			return { status: "invalid", message: "Invalid response fields." };
		}
		const action = entry.request.actions.find(action => action.id === response.action);
		if (!action || action.disabled) return { status: "invalid", message: "Action is unavailable." };
		if (action.localRequired)
			return { status: "local_required", message: "This action requires the local terminal." };
		if (entry.request.kind === "plan_review") {
			if (response.modelId !== undefined && !entry.request.models.some(model => model.id === response.modelId)) {
				return { status: "invalid", message: "Unknown execution model." };
			}
			if (response.action === "plan.refine" && !(response.feedback ?? entry.request.feedback)?.trim()) {
				return { status: "invalid", message: "Refinement requires feedback." };
			}
		}
		let invalid: string | undefined;
		try {
			invalid = await entry.options.validate(response);
		} catch {
			return matches() ? { status: "invalid", message: "Decision could not be validated." } : { status: "stale" };
		}
		if (!matches()) return { status: "stale" };
		if (invalid !== undefined) return { status: "invalid", message: invalid };
		const receiptId = randomUUID();
		this.#close(entry, "accepted", receiptId, false);
		// Acceptance is published before native continuation, never model completion.
		entry.options.resolve(response);
		return { status: "accepted", receiptId };
	}

	#publish(entry: RecordEntry, change: InteractionRequestEvent["change"], reason?: string, receiptId?: string): void {
		try {
			this.notify({
				type: "interaction_request",
				change,
				request: structuredClone(entry.request),
				reason,
				receiptId,
			});
		} catch {
			/* Notification failures cannot affect native UI. */
		}
	}

	#close(entry: RecordEntry, reason: string, receiptId?: string, notifyOwner = true): void {
		if (this.#records.get(entry.request.requestId) !== entry) return;
		this.#records.delete(entry.request.requestId);
		this.#publish(entry, "closed", reason, receiptId);
		if (notifyOwner) entry.options.onClose?.(reason);
	}
}
