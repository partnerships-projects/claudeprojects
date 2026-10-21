# Mailjet access

`mailjet_pull.py` is a read-only puller for one Mailjet account.

## One key per account

Each "MJ" sending platform in the fleet — Addison MJ, Laura MJ, Megan MJ,
Atmosfy Mj, SS MJ — is a **separate Mailjet account**, and a Mailjet API key
is scoped to its own account. A key sees that account's senders, messages and
statistics and nothing of any other account's. There is no cross-account view,
so covering the fleet means one key per account and running the puller once
per key.

Two further traps when collecting keys:

- A **sub-account key** authenticates fine and returns `HTTP 200` for every
  endpoint, but reads an empty namespace: `sender`, `message` and
  `contactslist` all come back `Count=0`. Confirm a key with
  `mailjet_pull.py senders` before trusting anything else from it — real
  senders means the right key.
- Mailjet's own `/v3/REST/apikey` endpoint returns **live keys and secrets in
  the response body**. The puller refuses to read it. Nothing here needs it.

Do not regenerate or reset the key SalesHandy authenticates with. SMTP auth
breaks the moment it changes, and every mailbox on that account stops sending.

## Credentials

Preferred: put the key and secret in the environment's **Network secrets**
scoped to `api.mailjet.com`, so the outbound proxy attaches them and the
credentials never enter the process or the transcript. The puller sends no
`Authorization` header in this mode and works unchanged.

Outside the proxy, set `MJ_APIKEY` and `MJ_SECRET` in the environment. Never
pass credentials as command-line arguments.

## Commands

| Command | What it answers |
| --- | --- |
| `senders` | Which addresses and domains this key can send as, and whether they are active. Use it to confirm a key is the right one. |
| `domains` | Mailjet's last SPF/DKIM validation per domain. |
| `fleet-daily` | Account-wide sent / blocked / bounced / spam / unsub per day. |
| `mailbox-daily` | **Per-mailbox daily send volume.** |
| `failures` | Non-delivered messages with the receiving server's own SMTP response text. |
| `webhooks` | Event callback URLs and whether Mailjet still delivers to them. |

`--days N` sets the lookback, `--json` emits raw rows for piping.

## What Mailjet is and is not good for

**Per-mailbox daily send volume (`mailbox-daily`) exists nowhere else.**
SalesHandy exposes a configured daily *limit*, which is a ceiling rather than
what went out; Postmaster aggregates to the domain. Mailjet has the real
per-mailbox figure, which matters because measured volume per mailbox tracks
spam rate far more closely than the limit does.

**Bounce and block reasons (`failures`) are the receiver's own words**, SMTP
code and text, attributed to the sending mailbox. That distinguishes a
recipient-side failure (full mailbox, address does not exist) from
reputation-driven rejection, which no other source in the stack shows.
`preblocked` is Mailjet's own suppression list, not the receiver.

Two things Mailjet cannot tell you, both easy to misread:

- **Open rates.** Mailjet open and click tracking is off for this traffic
  (`IsOpenTracked: false`), so its per-day opened counts read 0 regardless of
  reality. SalesHandy's own tracking pixel is the only open signal.
- **Spam complaints, for Gmail.** Mailjet's lifetime `MessageSpamCount` on the
  Addison account is 48 against 1.69M sent, about 0.003%, while Postmaster
  reports 1–3% for the same domains. Mailjet only counts complaints that reach
  it through a feedback loop, and Gmail does not supply one. Postmaster is the
  only usable complaint source; a low Mailjet spam count means nothing.

## Known state, Addison MJ, 2026-10-21

All six event callbacks (`open`, `click`, `bounce`, `spam`, `blocked`,
`unsub`) point at one plain-HTTP host and are in Mailjet's `dead` state,
meaning Mailjet has stopped delivering events to them. Anything downstream
that learned about bounces, blocks or complaints through that callback has
been blind for as long as it has been dead — Mailjet does not record when a
callback died. Worth reconciling against the bounce counts SalesHandy
reports, since `failures` shows real bounces that a dead callback would never
have relayed.
