# Remind API — capture log

Everything here was executed against the live `remind.com` API during the build
(2026-08-28) from a **subscriber (parent)** account. Where a behaviour depends on the
account's role, that is called out — an owner/teacher account sees more.

## Endpoint

Single GraphQL endpoint: `POST https://www.remind.com/graphql`
(`/hq/graphql` also exists and answers, but the web app's data lives on `/graphql`.)

Reachable **server-side with plain curl** — no bot wall, no interstitial. The browser is
needed only to obtain the credential.

## Authentication

| Header | Source | Notes |
|---|---|---|
| `cookie` | full Cookie request header from a signed-in tab | includes HttpOnly session cookies |
| `x-csrf-token` | value of the `csrf_token` cookie (JS-readable, 36-char UUID) | Rails-style CSRF |

Verified by elimination — with a valid cookie jar:

| Header sent | Result |
|---|---|
| *(cookie only, no CSRF header)* | `errors[0].message = "Unauthorized"` |
| `x-csrf-token` | **authenticated** |
| `x-xsrf-token` | `Unauthorized` |
| `csrf-token` | `Unauthorized` |

**A named cookie read returns nothing.** `fpx cookies csrf_token -p remind` (and every
`--storage-domain` / `--storage-subdomain` variant) resolves to `{}` with the four requested
keys reported under `missing`. Request-**header** capture works and is therefore the only
route — hence the profile declares `--capture-header` and no `--cookie` scope.

Both headers ride the same request, so the two captures must be armed **concurrently**;
armed in series, the second waits for a request that has already gone by.

## Introspection

**Enabled**, unauthenticated. 750 named types: 478 objects, 155 inputs, 85 enums,
**84 Query root fields, 147 Mutation root fields**.

```bash
curl -s -X POST https://www.remind.com/graphql -H 'content-type: application/json' \
  -d '{"query":"{__type(name:\"Query\"){fields{name}}}"}'
```

This is why no field in this repo is guessed: the schema is authoritative and free to read.

## Error semantics — three traps

1. **An expired session is HTTP 200.** The body carries `errors[0].message == "Unauthorized"`.
   Status-code-only expiry detection cannot work; `client.ts` sniffs the body.
2. **`Unauthorized` is overloaded.** It also means "this account may not do that". A subscriber
   account gets it for `api_scheduledMessages` with a perfectly valid session, so a re-login
   loop on this signal alone would spin forever. The client re-captures once, then reports both
   possible causes.
3. **An unknown field is `Internal service error`.** Selecting a field that does not exist returns
   `extensions.code = GRAPHQL_VALIDATION_FAILED` wrapped around a **500** — not a readable
   "Cannot query field". Guessing is expensive; introspect instead. (`name { first }` on `User`
   produced exactly this; the real field is the scalar `first_name`.)

## Verified queries

| Query | Notes |
|---|---|
| `me` | `User`, 68 fields. Scalars include `uuid`, `first_name`, `email`, `locale`, `is_admin`, `is_child`. |
| `navigationList` | The sidebar; the entry point. Union items: `TextHeader`, `NavigationListActionItem`, `NavigationListEntityItem`. Entity fields are `title`/`type`/`unreadsCount` — **not** `name`/`entityType`/`unreadCount`. |
| `classes(uuids:)` | `[Class]`. `groupsByCode` looks similar but returns `UnsubscribedGroup`, a different type. |
| `chatStreams(chatUuids:,groupId:,chatQuery:)` | `[ChatStream]`. `groupId` is the **numeric class id**, not the uuid. |
| `chatStreams{ sequenceItems }` | Messages. `streams(uuids:)` returns a *different* type (`Stream`) without `title`. |
| `accountNotificationsScreen` | Preferences + delivery devices. |

`StreamItem` is an interface: `MessageItem`, `SystemMessageItem`, `GapItem`, `PhoneCallItem`,
`VideoChatMessageInviteItem`. A `GapItem` means `size` unloaded messages — observed in real data,
so any transcript renderer must handle it.

## Writes

### Verified live: `updateAccountNotificationsScreen`

Exercised end-to-end through the built MCP server against a real device:

```
dry-run  -> no network call, input {"devicesToDisable":[<id>]}
disable  -> re-read reports isEnabled: false
restore  -> re-read reports isEnabled: true
```

The device was returned to its original enabled state. A 200 alone proves nothing, so the tool
re-reads and reports the **observed** state of exactly the devices the call named.

> Verification harness note: driving several `tools/call` requests down stdin at once lets the
> MCP server run them **concurrently**, and a restore can land before the preceding re-read.
> That produced a false "unchanged" reading that looked like a product bug. Sequence write
> verifications one at a time.

### Shape only, not executed: `putMessage`

`PutMessageInput { recipients: [RecipientInput!]!, message: MessageInput!, … }`,
`RecipientInput { type, uuid }` with `type` of `chat` or `group`.
Deliberately never fired: every recipient is a real person and there is **no create-class
mutation**, so no throwaway target exists. Check `permissions.canSend` first.

### Owner/teacher only

`scheduleMessage`, `api_scheduledMessages`, `api_deleteScheduledMessage` → `Unauthorized` on a
subscriber account. Schedule-then-delete was therefore rejected as a verification strategy: it
would create state with no working read-back path to confirm deletion.

## Observed account shape

A subscriber (parent) account: `groups.ownedGroups` empty, one class, three chat streams,
`canEditInfo`/`canAddOwners` false, `canManageReplies`/`canManageCalls` false,
`permissions.canSend` true on the 1:1 chat.
