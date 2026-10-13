import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import type { ExtensionContext, InteractionResponse, PendingInteraction } from "@oh-my-pi/pi-coding-agent";
import { SlackInteractions, config } from "./transport";
import { answer, card, chunks, fullText, modal, planFeedback } from "./render";

export const request: PendingInteraction = {
	instanceId: "process",
	sessionId: "session",
	requestId: "ask",
	revision: 1,
	kind: "ask",
	questions: [{ id: "q", question: "Pick", options: [{ label: "One" }, { label: "Two" }], multi: true }],
	actions: [
		{ id: "ask.submit", label: "Answer" },
		{ id: "cancel", label: "Cancel" },
	],
};
export async function signedSmoke() {
	const secret = "temporary-smoke-signing-key";
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	let serial = 0;
	const api = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const method = new URL(req.url).pathname.split("/").pop()!;
			const text = await req.text();
			const body = (
				req.headers.get("content-type")?.includes("application/json")
					? JSON.parse(text)
					: Object.fromEntries(new URLSearchParams(text))
			) as Record<string, unknown>;
			calls.push({ method, body });
			if (method === "auth.test") return Response.json({ ok: true, user_id: "BOT", team_id: "TEAM", bot_id: "BOT" });
			if (method === "users.info")
				return Response.json({
					ok: true,
					user: { id: "USER", name: "reviewer", real_name: "Reviewer", is_bot: false },
				});
			if (method === "conversations.info")
				return Response.json({ ok: true, channel: { id: "CHANNEL", name: "review" } });
			const ts = String(++serial) + ".000001";
			return Response.json({
				ok: true,
				channel: "CHANNEL",
				ts,
				message: { ts, text: body.text ?? "", user: "BOT" },
				view: { id: "VIEW" },
			});
		},
	});
	let pending = [request];
	let executions = 0;
	const accepted: InteractionResponse[] = [];
	const ctx = {
		getPendingInteractions: () => pending,
		respondToInteraction: async (reply: InteractionResponse) => {
			accepted.push(reply);
			executions++;
			pending = [];
			return { status: "accepted" };
		},
	} as unknown as ExtensionContext;
	const settings = {
		token: "smoke-token",
		signingSecret: secret,
		channel: "CHANNEL",
		users: new Set(["USER"]),
		hostname: "127.0.0.1",
		port: 3218,
	};
	const transport = new SlackInteractions(
		settings,
		() => ctx,
		() => {},
		`http://127.0.0.1:${api.port}/api/`,
	);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => transport.webhook(req) });
	let responseBody = "";
	const send = async (payload: unknown, valid = true) => {
		const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
		const result = await fetch(`http://127.0.0.1:${server.port}/api/webhooks/slack`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-slack-request-timestamp": timestamp,
				"x-slack-signature": valid ? signature : "v0=invalid",
			},
			body,
		});
		responseBody = await result.text();
		await transport.flush();
		return result.status;
	};
	try {
		await transport.start();
		transport.publish(request);
		await transport.flush();
		const update = calls.find(c => c.method === "chat.update" && JSON.stringify(c.body.blocks).includes("cancel"));
		if (!update) throw new Error("Actual SDK did not publish interactive card");
		const blocks = typeof update.body.blocks === "string" ? JSON.parse(update.body.blocks) : update.body.blocks;
		const cancel = blocks
			.flatMap((b: { elements?: unknown[] }) => b.elements ?? [])
			.find((b: { action_id?: string }) => b.action_id === "cancel");
		const parent = calls.find(c => c.method === "chat.postMessage")!;
		const payload = {
			type: "block_actions",
			team: { id: "TEAM" },
			user: { id: "USER" },
			channel: { id: "CHANNEL" },
			message: { ts: update.body.ts, text: parent.body.text },
			container: { type: "message", channel_id: "CHANNEL", message_ts: update.body.ts },
			trigger_id: "trigger",
			actions: [{ type: "button", action_id: "cancel", value: cancel.value, action_ts: "123.1" }],
		};
		const bad = await send(payload, false);
		if (bad < 400 || executions) throw new Error("Invalid signature was not rejected");
		await send({ ...payload, user: { id: "INTRUDER" } });
		if (executions) throw new Error("Unauthorized user executed response");
		await send({
			...payload,
			message: { ts: "wrong", text: "" },
			container: { ...payload.container, message_ts: "wrong" },
		});
		if (executions) throw new Error("Wrong message executed response");
		pending = [{ ...request, revision: 2 }];
		await send(payload);
		if (executions) throw new Error("Old revision executed response");
		transport.publish(pending[0]!);
		await transport.flush();
		const replacement = calls.findLast(
			c => c.method === "chat.update" && JSON.stringify(c.body.blocks).includes("cancel"),
		)!;
		const replacementBlocks =
			typeof replacement.body.blocks === "string" ? JSON.parse(replacement.body.blocks) : replacement.body.blocks;
		const replacementCancel = replacementBlocks
			.flatMap((b: { elements?: unknown[] }) => b.elements ?? [])
			.find((b: { action_id?: string }) => b.action_id === "cancel");
		payload.message.ts = replacement.body.ts;
		payload.container.message_ts = replacement.body.ts;
		payload.actions[0]!.value = replacementCancel.value;
		await send(payload);
		if (executions !== 1) throw new Error("Signed production callback did not reach core responder");
		await send(payload);
		if (executions !== 1) throw new Error("Replay executed twice");
		if (request.kind !== "ask") throw new Error("fixture");
		pending = [
			{
				...request,
				revision: 3,
				questions: [
					...request.questions,
					{ id: "q2", question: "Next", options: [{ label: "Next answer" }], multi: false },
				],
			},
		];
		transport.publish(pending[0]!);
		await transport.flush();
		const askUpdate = calls.findLast(
			c => c.method === "chat.update" && JSON.stringify(c.body.blocks).includes("ask.submit"),
		)!;
		const askBlocks =
			typeof askUpdate.body.blocks === "string" ? JSON.parse(askUpdate.body.blocks) : askUpdate.body.blocks;
		const askButton = askBlocks
			.flatMap((b: { elements?: unknown[] }) => b.elements ?? [])
			.find((b: { action_id?: string }) => b.action_id === "ask.submit");
		await send({
			...payload,
			message: { ts: askUpdate.body.ts },
			container: { ...payload.container, message_ts: askUpdate.body.ts },
			actions: [{ type: "button", action_id: "ask.submit", value: askButton.value, action_ts: "124.1" }],
		});
		const open = calls.findLast(c => c.method === "views.open");
		if (!open) throw new Error("Actual SDK did not open answer modal");
		const view =
			typeof open.body.view === "string"
				? JSON.parse(open.body.view)
				: (open.body.view as { private_metadata: string });
		const submission = {
			type: "view_submission",
			team: { id: "TEAM" },
			user: { id: "USER" },
			view: {
				id: "VIEW",
				callback_id: "omp_response",
				private_metadata: view.private_metadata,
				state: {
					values: {
						selection: { selection: { value: "1,2" } },
						custom: { custom: { value: "Custom" } },
						note: { note: { value: "Note" } },
					},
				},
			},
		};
		await send({ ...submission, user: { id: "INTRUDER" } });
		if (executions !== 1) throw new Error("Unauthorized modal executed");
		await send({ ...submission, view: { ...submission.view, id: "WRONG_VIEW" } });
		expect(executions, "Wrong modal view cannot execute").toBe(1);
		await send({
			...submission,
			view: { ...submission.view, state: { values: { selection: { selection: { value: "999" } } } } },
		});
		expect(executions, "Invalid answer does not consume core response").toBe(1);
		await send(submission);
		expect(executions, "First question waits for complete answers").toBe(1);
		const continuation = JSON.parse(responseBody);
		if (continuation.response_action !== "update") throw new Error("SDK did not update second-question modal");
		const nextSubmission = {
			...submission,
			view: {
				...submission.view,
				private_metadata: continuation.view.private_metadata,
				state: {
					values: {
						selection: { selection: { value: "1" } },
						custom: { custom: { value: "" } },
						note: { note: { value: "Second note" } },
					},
				},
			},
		};
		await send(submission);
		expect(executions, "Replaying prior page cannot submit next question").toBe(1);
		await send(nextSubmission);
		expect(executions, "Actual SDK two-question modal reaches responder").toBe(2);
		expect(accepted.at(-1)?.answers).toEqual([
			{ id: "q", selectedOptions: ["One", "Two"], customAnswer: "Custom", note: "Note" },
			{ id: "q2", selectedOptions: ["Next answer"], customAnswer: undefined, note: "Second note" },
		]);
		await send(nextSubmission);
		expect(executions, "Modal replay executes no additional response").toBe(2);
		return { executions, slackApiCalls: calls.length };
	} finally {
		server.stop(true);
		await transport.stop();
		api.stop(true);
	}
}

test("missing credentials fail closed", () => {
	expect(config({})).toBeUndefined();
});
test("full text chunking is lossless including surrogate boundaries", () => {
	const text = "a".repeat(2399) + "😀" + "z".repeat(5000);
	expect(chunks(text).join("")).toBe(text);
});
test("multi/custom/note answers preserve values and reject invalid choices", () => {
	if (request.kind !== "ask") throw new Error("fixture");
	expect(answer(request, 0, { selection: "1,2", custom: "Custom", note: "Note" })).toEqual({
		id: "q",
		selectedOptions: ["One", "Two"],
		customAnswer: "Custom",
		note: "Note",
	});
	expect(() => answer(request, 0, { selection: "3" })).toThrow();
	expect(() => answer(request, 0, { selection: "1,1" })).toThrow();
	expect(fullText(request)).toContain("2. Two");
});
test("actual SDK signed HTTP callbacks authorize association and reject replay", signedSmoke);

test("plan rendering preserves full source and exposes only enabled remote actions and model", () => {
	const plan: PendingInteraction = {
		instanceId: "i",
		sessionId: "s",
		requestId: "p",
		revision: 4,
		kind: "plan_review",
		plan: "# Complete\n```ts\nconst answer = 42;\n```\n" + "content".repeat(10000),
		planFilePath: "/plan.md",
		contentHash: "hash",
		annotations: [],
		models: [{ id: "provider:model", label: "Execution" }],
		selectedModelId: "provider:model",
		actions: [
			{ id: "plan.approve.execute", label: "Execute" },
			{ id: "plan.approve.compact", label: "Compact" },
			{ id: "plan.approve.keep_context", label: "Keep", disabled: true },
			{ id: "plan.save_and_quit", label: "Quit", localRequired: true },
			{ id: "plan.refine", label: "Refine" },
		],
	};
	expect(chunks(fullText(plan)).join("")).toContain(plan.plan);
	const rendered = JSON.stringify(card(plan, "token"));
	expect(rendered).toContain("plan.approve.execute");
	expect(rendered).toContain("plan.approve.compact");
	expect(rendered).toContain("plan.refine");
	expect(rendered).not.toContain("plan.approve.keep_context");
	expect(rendered).not.toContain("plan.save_and_quit");
	expect(JSON.stringify(modal(plan, "form", "plan.refine"))).toContain("provider:model");
});

test("oversized existing plan feedback is preserved completely plus additional feedback", () => {
	const original = "Native instructions\n" + "Important feedback\n".repeat(400);
	expect(planFeedback(original, " Extra instruction ")).toBe(`${original}\n\nExtra instruction`);
	expect(planFeedback(original, "")).toBe(original);
	expect(planFeedback("short existing", "edited feedback")).toBe("edited feedback");
	const plan: PendingInteraction = {
		instanceId: "i",
		sessionId: "s",
		requestId: "p",
		revision: 1,
		kind: "plan_review",
		plan: "Full plan",
		planFilePath: "/plan.md",
		contentHash: "hash",
		annotations: [],
		models: [],
		feedback: original,
		actions: [{ id: "plan.refine", label: "Refine" }],
	};
	const input = modal(plan, "form", "plan.refine").children.find(
		child => child.type === "text_input" && child.id === "feedback",
	);
	if (!input || input.type !== "text_input") throw new Error("Missing rendered feedback input");
	expect(input.optional).toBe(true);
	expect(input.initialValue).toBeUndefined();
	const emptyInput = modal({ ...plan, feedback: "" }, "form", "plan.refine").children.find(
		child => child.type === "text_input" && child.id === "feedback",
	);
	if (!emptyInput || emptyInput.type !== "text_input") throw new Error("Missing rendered feedback input");
	expect(emptyInput.optional).toBe(false);
});
