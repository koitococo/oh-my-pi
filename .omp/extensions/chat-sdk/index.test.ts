import { expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import slackInteractions from "./index";

function rejectSubscription() {
	throw new Error("Unsupported hosts must not register interaction or session handlers");
}

test("factory leaves legacy hosts without capability discovery disabled", () => {
	const on = mock(rejectSubscription);
	const host = { on } as unknown as ExtensionAPI;

	slackInteractions(host);

	expect(on).not.toHaveBeenCalled();
});

test("factory leaves hosts with non-callable capability discovery disabled", () => {
	const on = mock(rejectSubscription);
	const host = { hasCapability: true, on } as unknown as ExtensionAPI;

	slackInteractions(host);

	expect(on).not.toHaveBeenCalled();
});

test("factory cannot enable Slack interactions when the host rejects the capability", () => {
	const on = mock(rejectSubscription);
	const host = {
		hasCapability: () => false,
		on,
	} as unknown as ExtensionAPI;

	slackInteractions(host);

	expect(on).not.toHaveBeenCalled();
});
