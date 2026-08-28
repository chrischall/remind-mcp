# remind-mcp

MCP server for [Remind](https://www.remind.com) — read your classes, chats and messages, and
manage notification settings.

> This project was developed and is maintained by AI. Use at your own discretion.

Remind exposes a single GraphQL endpoint that is reachable server-side, so only the
*credential* needs a browser: the session is lifted once from a signed-in tab through the
fetchproxy bridge, and every request after that is a plain server-side fetch.

## Install

```bash
npx -y @chrischall/remind-mcp
```

```json
{
  "mcpServers": {
    "remind": { "command": "npx", "args": ["-y", "@chrischall/remind-mcp"] }
  }
}
```

## Authentication

Two headers are captured from a signed-in `remind.com` tab: the full `Cookie` header and the
`x-csrf-token` value. Either let the bridge capture them (needs the **Transporter** Chrome
extension and a signed-in tab), or supply them yourself:

| Variable | Required | Description |
|---|---|---|
| `REMIND_COOKIE` | no | Captured `Cookie` request header. Skips the bridge when set with the next one. |
| `REMIND_CSRF_TOKEN` | no | Captured `x-csrf-token` value. |
| `REMIND_WS_PORT` | no | fetchproxy bridge concentrator port (default `37149`). |
| `REMIND_SESSION_FILE` | no | Where the captured session is cached. Defaults to `$MCP_DATA_DIR`/`$HOME` under `.remind-mcp`. |

The server boots without either, so a host's install-time `tools/list` probe succeeds; the
error surfaces on the first tool call instead.

**The browser is needed once.** A captured session is cached (mode `0600`) and reused across
restarts, and every call after the bootstrap is a plain server-side fetch. This matters because
the capture completes only while the signed-in tab is actually issuing a `/graphql` request — so
without the cache, a restart would sit waiting unless you happened to be using Remind.

## Tools

| Tool | |
|---|---|
| `remind_me` | The signed-in account. |
| `remind_list_entities` | Classes and chats with unread counts — **start here**, it yields the uuids. |
| `remind_get_classes` | Full class detail by uuid. |
| `remind_list_chats` | Conversation streams and their permissions (`canSend`). |
| `remind_get_messages` | Messages in a chat stream. |
| `remind_get_notification_settings` | Preferences and delivery devices. |
| `remind_set_notification_devices` | Enable/disable delivery devices. **Confirm-gated.** |
| `remind_send_message` | Send to a chat or class. **Confirm-gated.** |
| `remind_graphql` | Arbitrary read-only GraphQL; introspection is enabled. Mutations refused. |
| `remind_healthcheck` | Verify the session still authenticates. |

Write tools take `confirm: true`. Without it they make **no network call** and return a dry-run
preview of the exact payload.

## Without the server

`skills/remind-fpx/` is a shell-only skill covering the same read surface with `fpx` + `curl` —
no MCP process required.

## Notes

- An expired session returns **HTTP 200** with `errors[0].message = "Unauthorized"`; the same
  string also means "your account may not do that" (scheduled messages are owner/teacher-only).
- An unknown field reports as `Internal service error`, not a field error — introspect rather
  than guess. `docs/REMIND-API.md` is the capture log.

## Development

```bash
npm install && npm run build && npm test
npm run test:coverage
```

## License

MIT
