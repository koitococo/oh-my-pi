# Slack interaction extension (Chat SDK)

An installable, in-process OMP extension using official Vercel Chat SDK `chat`, `@chat-adapter/slack`, and `@chat-adapter/state-memory`, pinned to npm stable **4.41.1**. Requires a host advertising the `interaction-requests` capability, covering the public `interaction_request` event and `getPendingInteractions` / `respondToInteraction` context APIs. No daemon, remote bridge, model credentials, or root dependencies are required.

## Install

From the repository root run `cd .omp/extensions/chat-sdk && bun install`, then start the modified OMP checkout from the repository root. Project extension discovery automatically loads `.omp/extensions/chat-sdk/index.ts`; sibling helpers and tests are not discovered as separate extensions. No settings entry or `omp install` is needed for this project-local placement. Installed `node_modules` stays local and must not be committed.

To use this extension from another project, start the modified checkout with `omp -e /absolute/path/to/.omp/extensions/chat-sdk/index.ts`, or use `omp install /absolute/path/to/.omp/extensions/chat-sdk` to register the package's `omp.extensions` entry. Do not also register an explicit entry when native project discovery already loads it. Install dependencies in this package, not at repository root. The extension itself uses only public, type-only OMP imports; its tsconfig resolves those imports to this checkout.

The extension automatically disables itself on hosts without `hasCapability`, or when `hasCapability("interaction-requests")` returns false. It exits before subscribing to events, reading configuration, or starting the Slack transport/webhook server, leaving native interactions unchanged. An unmodified npm 18.10.3 host does not expose this capability. Other extensions can opt into the same fork functionality with this factory-entry guard; do not infer support from a version number or repository name:

```ts
if (typeof pi.hasCapability !== "function" || !pi.hasCapability("interaction-requests")) return;
```

Provide these environment variables using your secret manager or a protected environment file; never paste credentials into chat or commit them:

| Variable | Meaning |
| --- | --- |
| `OMP_SLACK_BOT_TOKEN` | Installed Slack app bot token |
| `OMP_SLACK_SIGNING_SECRET` | Slack app signing secret |
| `OMP_SLACK_CHANNEL` | One authorized destination channel ID, not channel name |
| `OMP_SLACK_USERS` | Required comma-separated authorized Slack user IDs |
| `OMP_SLACK_HOST` | Optional bind address, default `127.0.0.1` |
| `OMP_SLACK_PORT` | Optional HTTP port, default `3218` |

Missing credentials, empty allowlist, invalid port, or startup failure disables Slack delivery, warns once, and preserves native TUI interactions. Use a separate channel and port per active OMP process. The allowlist authorizes each listed user to answer any current interaction posted by this process to that channel. Channel readers can see plan and question content: only use a channel authorized for that information.

## Slack app and HTTPS deployment

Create an app at https://api.slack.com/apps in your workspace. Under OAuth & Permissions add bot scopes `chat:write`, `channels:read`, `groups:read` (if using a private channel), and `users:read`. Install/reinstall the app after scope changes; invite the bot to the configured channel. Obtain its bot token and signing secret separately from your configuration manager.

Enable **Interactivity & Shortcuts** and set Request URL to `https://your-omp-host.example/api/webhooks/slack`. Message subscriptions, slash commands, Socket Mode, and an LLM connection are unnecessary. Use an external HTTPS reverse proxy with a valid certificate that forwards POST bodies and Slack's `X-Slack-Signature` and `X-Slack-Request-Timestamp` unchanged to `http://127.0.0.1:3218/api/webhooks/slack`. Do not expose other OMP endpoints or bind publicly unless your network policy explicitly permits it. Keep proxy access logs free of request bodies. The process must be running for Slack to reach it; the default loopback server is not reachable directly by Slack.

Example Caddy route (hostname is illustrative, no credentials):

```caddy
omp-review.example.com {
    handle /api/webhooks/slack {
        reverse_proxy 127.0.0.1:3218
    }
    handle {
        respond "Not found" 404
    }
}
```

The actual Slack adapter verifies signatures and timestamp freshness. It is never bypassed in production. Action tokens are random, held only in process memory, and scoped to immutable interaction revision, configured channel, parent message, and allowlisted user. Modal tokens additionally bind the opening user and Slack view ID; SDK related message/thread associations are checked again. Restarting OMP revokes old tokens. The memory state adapter is deliberate: this is a single in-process consumer, not a horizontally replicated service. Old Slack cards may remain after an abrupt kill, but cannot execute in a restarted process.

## Use

When native ask or plan review opens, the extension posts a non-actionable parent and delivers **all** content in ordered thread parts, then enables its card. No plan truncation silently permits approval. Thread text is split under Slack limits, including Unicode boundaries. Plan annotations, feedback, and available model IDs are included. Native TUI remains usable throughout; first valid response wins in the core.

For ask, click **Answer**. Each question has its own modal: enter one option number, or comma-separated numbers for a multi-choice question, referring to the complete numbered question in the thread. You can instead or additionally provide custom text and an optional note. Submit advances to the next question; the final submission responds atomically. Numeric input is intentional: this SDK release has single-select/radio but no portable multi-select modal element, and numbered input also supports questions with more than Slack's 100 select options. Empty/invalid choices show an error without consuming the pending request. **Chat** requests native follow-up chat rather than tool execution; **Cancel** cancels the interaction.

For plan review, choose an enabled approval mode (execute, compact, or keep context), optionally select an execution model, or refine with meaningful feedback. Large model lists accept a listed model ID. Local-only save-and-quit is not offered remotely. Disabled actions are omitted. Approval means the core accepted a decision, **not** that execution finished or succeeded. Local edits, annotations, feedback or model changes replace the revision and close the old card. Native acceptance, abort, timeout, session switch, and shutdown revoke capabilities and remove remote buttons. Transport failures never synthesize approval and never replace native TUI behavior.

Existing feedback longer than Slack's 3000-character input limit remains complete in the thread and in the response: the modal asks for **additional** feedback, appended to the original rather than replacing a truncated prefix. Model IDs are opaque snapshot values, not provider names to parse.

Closing a Slack modal alone abandons that form; use the card's Cancel or the TUI to cancel the underlying request. If response validation fails, use the current card/TUI again. Slack content remains in channel history after closure; apply your workspace retention policy.

## Verification recipes

Run from this package after core changes have landed:

```sh
bun run test
bun run smoke
bun run check
```

Factory contract tests invoke the real extension with legacy and capability-rejecting hosts whose event registration throws, proving those hosts cannot register handlers that start Slack delivery.

The smoke uses the **production transport**, official SDK, a real loopback HTTP webhook server, correctly signed Slack callbacks, and a temporary HTTP fake Slack Web API endpoint. It checks signature rejection, user and message association, stale revision rejection, accepted callback forwarding, and replay non-execution. The API endpoint override is a constructor-only test seam; production configuration does not accept a fake API endpoint. Unit cases cover lossless full-content splitting, multi/custom/note conversion, invalid choices, and fail-closed configuration. No model or workspace credentials are used. These checks do not establish real Slack installation, live workspace permissions, proxy reachability, or Slack modal UX; validate those with a controlled live ask and plan review before using sensitive plans.

The signed modal smoke also exercises two questions, invalid choice correction, wrong view/user rejection, previous-page replay, and complete multi/custom/note forwarding. Per-page tokens rotate on continuation. The SDK removes its related-context storage on the first submission (including validation errors); the extension retains the original authenticated message/thread binding together with the opening user and exact view, so subsequent retries never relax authorization.

SDK documentation: https://chat-sdk.dev/docs/actions, https://chat-sdk.dev/docs/modals, https://chat-sdk.dev/docs/api/cards, https://github.com/vercel/chat/tree/main/apps/docs/content/docs. Installed 4.41.1 declarations were used to confirm factory card/modal APIs, callback identity fields, `apiUrl`, and webhook `waitUntil` completion.
