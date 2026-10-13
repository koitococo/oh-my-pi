import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	InteractionBroker,
	type InteractionPayload,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/interaction-broker";
import { bindPreparedExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	InteractionRequestEvent,
	InteractionResponse,
	PendingInteraction,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
}
function ask(): InteractionPayload {
	return {
		kind: "ask",
		questions: [{ id: "q", question: "Choose", options: [{ label: "One" }] }],
		actions: [
			{ id: "ask.submit", label: "Submit" },
			{ id: "ask.chat", label: "Chat" },
		],
	};
}
function plan(): InteractionPayload {
	return {
		kind: "plan_review",
		plan: "# Plan\nDo it",
		planFilePath: "/plan.md",
		contentHash: "hash",
		annotations: [],
		models: [{ id: "model", label: "Model" }],
		actions: [
			{ id: "plan.approve.execute", label: "Execute" },
			{ id: "plan.approve.compact", label: "Compact", disabled: true },
			{ id: "plan.refine", label: "Refine" },
			{ id: "plan.save_and_quit", label: "Save", localRequired: true },
		],
	};
}
function reply(request: PendingInteraction, extra: Partial<InteractionResponse> = {}): InteractionResponse {
	return {
		instanceId: request.instanceId,
		sessionId: request.sessionId,
		requestId: request.requestId,
		revision: request.revision,
		action: "ask.submit",
		answers: [{ id: "q", selectedOptions: ["One"] }],
		...extra,
	};
}

describe("InteractionBroker capabilities", () => {
	it("copies open/update inputs, query snapshots, handle snapshots, and event snapshots", () => {
		const events: InteractionRequestEvent[] = [];
		const broker = new InteractionBroker(
			() => "session",
			event => {
				events.push(event);
			},
		);
		const payload = ask();
		const handle = broker.open(payload, { validate: () => undefined, resolve: () => {} });
		payload.actions[0]!.label = "input mutation";
		events[0]!.request.actions[0]!.label = "event mutation";
		const snapshot = broker.getPendingInteractions()[0]!;
		snapshot.actions[0]!.label = "query mutation";
		handle.request.actions[0]!.label = "handle mutation";
		expect(handle.request.actions[0]!.label).toBe("Submit");
		const next = ask();
		next.actions[0]!.label = "Updated";
		handle.update(next);
		next.actions[0]!.label = "next mutation";
		events[1]!.request.actions[0]!.label = "updated event mutation";
		expect(handle.request.actions[0]!.label).toBe("Updated");
		expect(handle.request.revision).toBe(2);
		expect(snapshot.revision).toBe(1);
	});

	it("does not consume invalid or throwing validation and copies responses before async validation", async () => {
		const gate = deferred<string | undefined>();
		const resolved: InteractionResponse[] = [];
		let calls = 0;
		const broker = new InteractionBroker(
			() => "session",
			() => {},
		);
		const handle = broker.open(ask(), {
			validate: () => {
				calls++;
				if (calls === 1) return "Invalid answer";
				if (calls === 2) throw new Error("validation failed");
				return gate.promise;
			},
			resolve: response => {
				resolved.push(response);
			},
		});
		expect((await broker.respondToInteraction(reply(handle.request))).status).toBe("invalid");
		expect((await broker.respondToInteraction(reply(handle.request))).status).toBe("invalid");
		expect(broker.getPendingInteractions()).toHaveLength(1);
		const response = reply(handle.request);
		const pending = broker.respondToInteraction(response);
		response.answers![0]!.selectedOptions[0] = "mutated";
		gate.resolve(undefined);
		expect((await pending).status).toBe("accepted");
		expect(resolved[0]!.answers![0]!.selectedOptions).toEqual(["One"]);
	});

	it("rejects stale instance/session/revision scopes without consuming the current request", async () => {
		let session = "session";
		const events: InteractionRequestEvent[] = [];
		const broker = new InteractionBroker(
			() => session,
			event => {
				events.push(event);
			},
		);
		const handle = broker.open(ask(), { validate: () => undefined, resolve: () => {} });
		const old = handle.request;
		for (const extra of [{ instanceId: "other" }, { sessionId: "other" }, { requestId: "other" }]) {
			expect((await broker.respondToInteraction(reply(old, extra))).status).toBe("stale");
		}
		handle.update(ask());
		expect((await broker.respondToInteraction(reply(old))).status).toBe("stale");
		expect(broker.getPendingInteractions()).toHaveLength(1);
		session = "new-session";
		expect((await broker.respondToInteraction(reply(handle.request))).status).toBe("stale");
		expect(broker.getPendingInteractions()).toEqual([]);
		expect(events.at(-1)?.reason).toBe("session_changed");
	});

	it("lets the first valid async decision win exactly once across native and extension responders", async () => {
		const gates = [deferred<string | undefined>(), deferred<string | undefined>()];
		const resolved: InteractionResponse[] = [];
		const events: InteractionRequestEvent[] = [];
		let calls = 0;
		const broker = new InteractionBroker(
			() => "session",
			event => {
				events.push(event);
			},
		);
		const handle = broker.open(ask(), {
			validate: () => gates[calls++]!.promise,
			resolve: response => {
				resolved.push(response);
			},
		});
		const remote = broker.respondToInteraction(reply(handle.request));
		const local = handle.respond({ action: "ask.chat" });
		gates[1]!.resolve(undefined);
		const winner = await local;
		expect(winner.status).toBe("accepted");
		expect(winner.receiptId).toBeTruthy();
		gates[0]!.resolve(undefined);
		expect((await remote).status).toBe("stale");
		expect(resolved.map(response => response.action)).toEqual(["ask.chat"]);
		expect(events.filter(event => event.change === "closed")).toHaveLength(1);
		expect(events.at(-1)?.receiptId).toBe(winner.receiptId);
		expect((await handle.respond({ action: "ask.submit" })).status).toBe("stale");
	});

	it("revokes in-flight validation on update and close, and closes owners only once", async () => {
		for (const operation of ["update", "close", "closeAll"] as const) {
			const gate = deferred<string | undefined>();
			const resolved: InteractionResponse[] = [];
			const closed: string[] = [];
			const broker = new InteractionBroker(
				() => "session",
				() => {},
			);
			const handle = broker.open(ask(), {
				validate: () => gate.promise,
				resolve: response => {
					resolved.push(response);
				},
				onClose: reason => {
					closed.push(reason);
				},
			});
			const pending = broker.respondToInteraction(reply(handle.request));
			if (operation === "update") handle.update(ask());
			else if (operation === "close") handle.close("cancelled");
			else broker.closeAll("shutdown");
			gate.resolve(undefined);
			expect((await pending).status).toBe("stale");
			expect(resolved).toEqual([]);
			handle.close("cleanup");
			handle.close("again");
			expect(closed).toHaveLength(1);
		}
	});

	it("keeps local save, disabled actions, unknown models, and empty refine feedback non-consuming", async () => {
		const broker = new InteractionBroker(
			() => "session",
			() => {},
		);
		let validations = 0;
		const handle = broker.open(plan(), {
			validate: () => {
				validations++;
				return undefined;
			},
			resolve: () => {},
		});
		for (const [extra, status] of [
			[{ action: "plan.save_and_quit" }, "local_required"],
			[{ action: "plan.approve.compact" }, "invalid"],
			[{ action: "ask.submit" }, "invalid"],
			[{ action: "plan.approve.execute", modelId: "unknown" }, "invalid"],
			[{ action: "plan.refine", feedback: " \n " }, "invalid"],
		] as const) {
			expect((await broker.respondToInteraction(reply(handle.request, extra))).status).toBe(status);
			expect(broker.getPendingInteractions()).toHaveLength(1);
		}
		expect(validations).toBe(0);
		const next = plan();
		if (next.kind === "plan_review") next.feedback = "Improve the steps";
		handle.update(next);
		expect(
			(await broker.respondToInteraction(reply(handle.request, { action: "plan.refine", modelId: "model" }))).status,
		).toBe("accepted");
		expect(validations).toBe(1);
	});

	it("notification failures do not prevent native acceptance", async () => {
		let resolved = false;
		const broker = new InteractionBroker(
			() => "session",
			() => {
				throw new Error("transport offline");
			},
		);
		const handle = broker.open(ask(), {
			validate: () => undefined,
			resolve: () => {
				resolved = true;
			},
		});
		handle.update(ask());
		expect((await handle.respond({ action: "ask.chat" })).status).toBe("accepted");
		expect(resolved).toBe(true);
	});
});

describe("ExtensionRunner interaction contexts", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	beforeAll(async () => {
		directory = TempDir.createSync("@pi-interactions-");
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		registry = new ModelRegistry(auth);
	});
	afterAll(() => {
		auth.close();
		directory.removeSync();
	});
	const actions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	};
	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	};

	it("direct AgentSession abort synchronously revokes Ask and plan decisions without context abort or dialog signals", async () => {
		const loaded = await bindPreparedExtensions([], directory.path());
		const manager = SessionManager.inMemory();
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory.path(), manager, registry);
		runner.initialize(actions, contextActions);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({
				responses: [
					() => {
						throw new Error("Abort regression must not dispatch a provider request");
					},
				],
			}).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: registry,
			extensionRunner: runner,
		});
		try {
			const closed: string[] = [];
			let accepted = false;
			const pending = [ask(), plan()].map(payload =>
				runner.interactions.open(payload, {
					validate: () => undefined,
					resolve: () => {
						accepted = true;
					},
					onClose: reason => closed.push(reason),
				}),
			);
			const snapshots = pending.map(handle => handle.request);
			const aborting = session.abort();
			// Revocation must happen before any agent-idle/maintenance await.
			expect(runner.createContext().getPendingInteractions()).toEqual([]);
			expect(closed).toEqual(["aborted", "aborted"]);
			await aborting;
			expect(await runner.createContext().respondToInteraction(reply(snapshots[0]!))).toMatchObject({
				status: "stale",
			});
			expect(
				await runner
					.createContext()
					.respondToInteraction(reply(snapshots[1]!, { action: "plan.approve.execute", answers: undefined })),
			).toMatchObject({ status: "stale" });
			expect(accepted).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("exposes copied snapshots and revokes saved contexts on rebind, abort, and shutdown", async () => {
		const loaded = await bindPreparedExtensions([], directory.path());
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			directory.path(),
			SessionManager.inMemory(),
			registry,
		);
		runner.initialize(actions, contextActions);
		const context = runner.createContext();
		const reasons: string[] = [];
		for (const operation of ["rebind", "abort", "shutdown"] as const) {
			const handle = runner.interactions.open(ask(), {
				validate: () => undefined,
				resolve: () => {},
				onClose: reason => {
					reasons.push(reason);
				},
			});
			const snapshot = context.getPendingInteractions()[0]!;
			snapshot.actions[0]!.label = "mutated";
			expect(context.getPendingInteractions()[0]!.actions[0]!.label).toBe("Submit");
			if (operation === "rebind") runner.initialize(actions, contextActions);
			else if (operation === "abort") context.abort();
			else context.shutdown();
			expect((await context.respondToInteraction(reply(handle.request))).status).toBe("stale");
			expect(context.getPendingInteractions()).toEqual([]);
		}
		expect(reasons).toEqual(["rebound", "aborted", "shutdown"]);
	});

	it("delivers lifecycle notifications without awaiting a remote response handler", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const events: InteractionRequestEvent[] = [];
		const responses: Promise<unknown>[] = [];
		const loaded = await bindPreparedExtensions(
			[
				{
					path: path.join(directory.path(), "interaction-fixture.ts"),
					resolvedPath: path.join(directory.path(), "interaction-fixture.ts"),
					error: null,
					factory: pi => {
						pi.on("interaction_request", async (event, context) => {
							events.push(event);
							if (event.change !== "opened") return;
							entered.resolve();
							await release.promise;
							responses.push(context.respondToInteraction(reply(event.request)));
						});
					},
				},
			],
			directory.path(),
		);
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			directory.path(),
			SessionManager.inMemory(),
			registry,
		);
		let resolved = false;
		try {
			const handle = runner.interactions.open(ask(), {
				validate: () => undefined,
				resolve: () => {
					resolved = true;
				},
			});
			await entered.promise;
			handle.update(ask());
			const accepted = await handle.respond({ action: "ask.chat" });
			expect(accepted.status).toBe("accepted");
			expect(resolved).toBe(true);
			expect(events.map(event => event.change)).toEqual(["opened", "updated", "closed"]);
			release.resolve();
			await Promise.resolve();
			expect(await Promise.all(responses)).toEqual([{ status: "stale" }]);
		} finally {
			release.resolve();
			runner.clearManagedTimers();
		}
	});
});
