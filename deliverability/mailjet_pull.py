#!/usr/bin/env python3
"""Read-only puller for a Mailjet account.

Every "MJ" sending platform in the fleet (Addison MJ, Laura MJ, Megan MJ, ...)
is a separate Mailjet account with its own API key, and each key is its own
data namespace: a key sees nothing of another account's senders, messages or
statistics. So this runs once per account, with that account's key.

Auth, in order of preference:

  1. Nothing in the environment. Credentials are injected by an outbound
     proxy (Claude Code "Network secrets" scoped to api.mailjet.com), so the
     key never enters this process. This is the default and the safest mode.
  2. MJ_APIKEY / MJ_SECRET in the environment, sent as HTTP Basic auth
     (api key = username, secret = password). For running this outside the
     proxy. Never pass credentials on the command line.

Usage:
    python3 mailjet_pull.py senders
    python3 mailjet_pull.py domains
    python3 mailjet_pull.py fleet-daily   --days 21
    python3 mailjet_pull.py mailbox-daily --days 21
    python3 mailjet_pull.py failures      --days 7 --scan 2000
    python3 mailjet_pull.py webhooks

Add --json to any command to get the raw rows instead of a table.
"""

import argparse
import base64
import collections
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.mailjet.com/v3/REST"

# /v3/REST/apikey returns live API keys AND secrets in its response body.
# Reading it prints credentials into whatever is capturing this output.
# There is no diagnostic here that needs it.
FORBIDDEN = {"apikey", "apikeyaccess", "apikeytotals"}


def get(resource, **params):
    """GET one Mailjet resource. Returns the decoded body.

    Note: Mailjet silently ignores filter names it does not recognise and
    returns an unfiltered page, so never trust a filter to have applied.
    Known-good filters here are FromTS, ToTS, Limit, Offset, SourceID and
    the CounterSource/CounterTiming/CounterResolution triplet. In particular
    `Status` is NOT a filter on /message -- filter it client-side.
    """
    head = resource.split("?")[0].split("/")[0].lower()
    if head in FORBIDDEN:
        raise SystemExit(
            f"refusing to read /{head}: it returns live API keys and secrets "
            "in the response body"
        )

    qs = {k: v for k, v in params.items() if v is not None}
    url = f"{BASE}/{resource}"
    if qs:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(qs)

    req = urllib.request.Request(url)
    key, secret = os.environ.get("MJ_APIKEY"), os.environ.get("MJ_SECRET")
    if key and secret:
        token = base64.b64encode(f"{key}:{secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")

    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"HTTP {e.code} on /{resource}\n  {body}")


def since(days):
    midnight = dt.datetime.now(dt.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return int((midnight - dt.timedelta(days=days - 1)).timestamp())


def page(resource, limit=1000, **params):
    """Walk Offset until Mailjet stops returning rows."""
    rows, offset = [], 0
    while True:
        d = get(resource, Limit=limit, Offset=offset, **params)
        batch = d.get("Data", [])
        rows += batch
        if len(batch) < limit:
            return rows
        offset += limit


# ---------------------------------------------------------------- commands

def senders(args):
    rows = get("sender", Limit=200).get("Data", [])
    if args.json:
        return rows
    print(f"{'sender':40} {'status':10} kind")
    for s in sorted(rows, key=lambda r: r.get("Email", "")):
        email = s.get("Email", "")
        kind = "domain-wide" if email.startswith("*@") else "address"
        print(f"{email:40} {str(s.get('Status')):10} {kind}")
    print(f"\n{len(rows)} senders")
    return rows


def domains(args):
    """SPF/DKIM as Mailjet last validated it -- not what Postmaster reports.

    Mailjet checking OK only means the records resolve for Mailjet's own
    selector. It says nothing about DMARC alignment at the receiver, which
    is what Postmaster measures.
    """
    rows = get("dns", Limit=200).get("Data", [])
    if args.json:
        return rows
    print(f"{'domain':34} {'SPF':11} {'DKIM':11} last checked")
    broken = 0
    for r in sorted(rows, key=lambda x: x.get("Domain", "")):
        spf, dkim = str(r.get("SPFStatus")), str(r.get("DKIMStatus"))
        if spf != "OK" or dkim != "OK":
            broken += 1
        print(f"{r.get('Domain',''):34} {spf:11} {dkim:11} {r.get('LastCheckAt','')}")
    print(f"\n{len(rows)} domains, {broken} with SPF or DKIM not OK")
    return rows


COUNTERS = [
    ("sent", "MessageSentCount"),
    ("blocked", "MessageBlockedCount"),
    ("hard", "MessageHardBouncedCount"),
    ("soft", "MessageSoftBouncedCount"),
    ("spam", "MessageSpamCount"),
    ("unsub", "MessageUnsubscribedCount"),
    ("defer", "MessageDeferredCount"),
]


def fleet_daily(args):
    rows = get(
        "statcounters",
        CounterSource="APIKey",
        CounterTiming="Message",
        CounterResolution="Day",
        FromTS=since(args.days),
        Limit=400,
    ).get("Data", [])
    if args.json:
        return rows
    head = "  ".join(f"{label:>7}" for label, _ in COUNTERS)
    print(f"{'day':12} {head}")
    for r in sorted(rows, key=lambda x: x.get("Timeslice", "")):
        cells = "  ".join(f"{r.get(k, 0):7d}" for _, k in COUNTERS)
        print(f"{r['Timeslice'][:10]:12} {cells}")
    return rows


def mailbox_daily(args):
    """Per-mailbox daily send volume.

    This is the number nothing else in the stack records. SalesHandy exposes
    a configured daily limit, which is a ceiling and not what actually went
    out, and Postmaster aggregates to the domain. Mailjet is the only place
    the real per-mailbox figure exists.
    """
    addrs = [
        s for s in get("sender", Limit=200).get("Data", [])
        if not s.get("Email", "").startswith("*@")
    ]
    frm, series = since(args.days), {}
    for s in addrs:
        rows = get(
            "statcounters",
            CounterSource="Sender",
            CounterTiming="Message",
            CounterResolution="Day",
            SourceID=s["ID"],
            FromTS=frm,
            Limit=400,
        ).get("Data", [])
        for r in rows:
            if r.get("MessageSentCount"):
                series.setdefault(s["Email"], {})[r["Timeslice"][:10]] = r["MessageSentCount"]

    if args.json:
        return series
    if not series:
        print(f"no sends recorded by any of the {len(addrs)} addresses "
              f"in the last {args.days} days")
        return series

    days = sorted({d for v in series.values() for d in v})[-args.columns:]
    print(f"{'mailbox':38}", " ".join(f"{d[5:]:>5}" for d in days), "   peak   mean")
    for email, s in sorted(series.items(), key=lambda kv: -max(kv[1].values())):
        cells = " ".join("    ." if s.get(d) is None else f"{s[d]:5d}" for d in days)
        vals = list(s.values())
        print(f"{email:38} {cells}  {max(vals):5d}  {sum(vals)/len(vals):5.0f}")
    quiet = len(addrs) - len(series)
    print(f"\n{len(series)} of {len(addrs)} addresses sent; {quiet} silent")
    return series


def failures(args):
    """Non-delivered messages with the receiver's own SMTP text.

    /message cannot be filtered by status, so this pages the raw stream and
    filters locally -- hence --scan. Failures run around 1% of volume, so a
    scan of N rows surfaces roughly N/100 of them.
    """
    names = {s["ID"]: s["Email"] for s in get("sender", Limit=200).get("Data", [])}
    rows = page("message", limit=min(args.scan, 1000), FromTS=since(args.days))[: args.scan]
    bad = [r for r in rows if r.get("Status") != "sent"]

    detail = []
    for r in bad:
        hist = get(f"messagehistory/{r['ID']}").get("Data", [])
        last = hist[-1] if hist else {}
        detail.append({
            "at": r.get("ArrivedAt"),
            "sender": names.get(r.get("SenderID"), f"sender#{r.get('SenderID')}"),
            "status": r.get("Status"),
            "state": last.get("State") or "",
            "reason": " ".join((last.get("Comment") or "").split()),
        })

    if args.json:
        return detail
    print(f"scanned {len(rows)} messages, {len(bad)} not delivered "
          f"({100 * len(bad) / max(len(rows), 1):.2f}%)\n")
    for d in sorted(detail, key=lambda x: (x["status"], x["at"] or "")):
        print(f"{d['status']:12} {d['at']}  {d['sender']}")
        if d["state"] or d["reason"]:
            print(f"             {d['state']:22} {d['reason'][:120]}")
    print("\nby state:")
    for (st, state), n in collections.Counter(
        (d["status"], d["state"]) for d in detail
    ).most_common():
        print(f"  {n:5d}  {st:12} {state}")
    return detail


def webhooks(args):
    """Mailjet event callbacks.

    A callback in `dead` state means Mailjet gave up delivering events to it.
    Anything downstream that learned about bounces, spam complaints or blocks
    through that callback has been blind since.
    """
    rows = get("eventcallbackurl", Limit=100).get("Data", [])
    if args.json:
        return rows
    print(f"{'event':12} {'status':10} url")
    for r in sorted(rows, key=lambda x: x.get("EventType", "")):
        print(f"{str(r.get('EventType')):12} {str(r.get('Status')):10} {r.get('Url','')}")
    dead = [r for r in rows if r.get("Status") == "dead"]
    if dead:
        print(f"\n{len(dead)} of {len(rows)} callbacks are dead -- "
              "Mailjet has stopped delivering those events")
    return rows


COMMANDS = {
    "senders": senders,
    "domains": domains,
    "fleet-daily": fleet_daily,
    "mailbox-daily": mailbox_daily,
    "failures": failures,
    "webhooks": webhooks,
}


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=sorted(COMMANDS))
    p.add_argument("--days", type=int, default=21, help="lookback window (default 21)")
    p.add_argument("--columns", type=int, default=7,
                   help="days shown in the mailbox-daily table (default 7)")
    p.add_argument("--scan", type=int, default=2000,
                   help="messages to page through for failures (default 2000)")
    p.add_argument("--json", action="store_true", help="emit raw rows")
    args = p.parse_args()

    out = COMMANDS[args.command](args)
    if args.json:
        json.dump(out, sys.stdout, indent=1)
        print()


if __name__ == "__main__":
    main()
