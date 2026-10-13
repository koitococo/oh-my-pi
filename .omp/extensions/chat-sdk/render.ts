import { Actions, Button, Card, Modal, Select, CardText as Text, TextInput, type ModalChild } from "chat";
import type { InteractionActionId, InteractionResponse, PendingInteraction } from "@oh-my-pi/pi-coding-agent";

export const scopeKey = (r: PendingInteraction) => `${r.instanceId}/${r.sessionId}/${r.requestId}`;
export function chunks(text: string, size = 2400): string[] {
	const result: string[] = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(start + size, text.length);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
		result.push(text.slice(start, end));
		start = end;
	}
	return result.length ? result : ["(empty)"];
}
export function fullText(r: PendingInteraction): string {
	if (r.kind === "plan_review")
		return `${r.planTitle ?? "Plan review"}\n${r.plan}\n\nReview annotations:\n${JSON.stringify(r.annotations)}\nFeedback: ${r.feedback ?? ""}`;
	return r.questions
		.map(
			(q, i) =>
				`${i + 1}. ${q.header ?? ""}\n${q.question}\n${q.options.map((o, j) => `${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}${o.preview ? `\n${o.preview}` : ""}`).join("\n")}\n${q.multi ? "Choose multiple numbers, separated by commas." : "Choose one number."}`,
		)
		.join("\n\n");
}
export function card(r: PendingInteraction, token: string) {
	const buttons = r.actions
		.filter(a => !a.disabled && !a.localRequired)
		.map(a =>
			Button({
				id: a.id,
				label: a.label.slice(0, 75),
				value: token,
				actionType: a.id === "cancel" || a.id === "ask.chat" ? "action" : "modal",
			}),
		);
	return Card({
		title: r.kind === "ask" ? "OMP asks" : "OMP plan review",
		children: [
			Text(
				`Revision ${r.revision}. Full content is in this message's thread. Native TUI remains available. Acceptance is not execution completion.`,
			),
			...Array.from({ length: Math.ceil(buttons.length / 5) }, (_, i) => Actions(buttons.slice(i * 5, i * 5 + 5))),
		],
	});
}
export function modal(r: PendingInteraction, token: string, action: InteractionActionId, questionIndex = 0) {
	const children: ModalChild[] = [];
	if (r.kind === "ask") {
		const q = r.questions[questionIndex]!;
		children.push(
			TextInput({
				id: "selection",
				label: `${q.multi ? "Option numbers, comma-separated" : "Option number"} (full question in thread)`,
				optional: true,
			}),
		);
		children.push(TextInput({ id: "custom", label: "Custom answer", multiline: true, optional: true }));
		children.push(TextInput({ id: "note", label: "Note", multiline: true, optional: true }));
	} else {
		children.push(
			TextInput({
				id: "feedback",
				label:
					(r.feedback?.length ?? 0) > 3000
						? "Additional feedback (full existing feedback in thread)"
						: action === "plan.refine"
							? "Required refinement feedback"
							: "Feedback (optional)",
				multiline: true,
				optional: action !== "plan.refine" || ((r.feedback?.length ?? 0) > 3000 && Boolean(r.feedback?.trim())),
				initialValue: (r.feedback?.length ?? 0) <= 3000 ? r.feedback : undefined,
			}),
		);
		if (r.models.length && r.models.length <= 100)
			children.push(
				Select({
					id: "model",
					label: "Execution model",
					optional: true,
					initialOption: r.selectedModelId,
					options: r.models.map(m => ({ label: m.label.slice(0, 75), value: m.id })),
				}),
			);
		else if (r.models.length)
			children.push(
				TextInput({
					id: "model",
					label: "Execution model ID (listed in thread)",
					initialValue: r.selectedModelId,
					optional: true,
				}),
			);
	}
	return Modal({
		callbackId: "omp_response",
		title: r.kind === "ask" ? `Question ${questionIndex + 1}/${r.questions.length}` : "Review plan",
		privateMetadata: token,
		submitLabel: r.kind === "ask" && questionIndex + 1 < r.questions.length ? "Next question" : "Submit",
		children,
	});
}
export function answer(r: Extract<PendingInteraction, { kind: "ask" }>, index: number, values: Record<string, string>) {
	const q = r.questions[index]!;
	const input = (values.selection ?? "").trim();
	const indices = input ? input.split(",").map(x => Number(x.trim()) - 1) : [];
	if (
		indices.some(i => !Number.isInteger(i) || i < 0 || i >= q.options.length) ||
		new Set(indices).size !== indices.length ||
		(!q.multi && indices.length > 1)
	)
		throw new Error("Enter valid option numbers from the thread.");
	const customAnswer = values.custom?.trim() || undefined;
	if (!indices.length && !customAnswer) throw new Error("Choose an option or provide a custom answer.");
	return {
		id: q.id,
		selectedOptions: indices.map(i => q.options[i]!.label),
		customAnswer,
		note: values.note?.trim() || undefined,
	};
}
export function response(r: PendingInteraction, action: InteractionActionId): InteractionResponse {
	return { instanceId: r.instanceId, sessionId: r.sessionId, requestId: r.requestId, revision: r.revision, action };
}

export function planFeedback(existing: string | undefined, input: string | undefined): string | undefined {
	const additional = input?.trim();
	if ((existing?.length ?? 0) <= 3000) return additional;
	return additional ? `${existing}\n\n${additional}` : existing;
}
