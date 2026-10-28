'use strict';
/**
 * Notion "Domain Health History" rows  ->  the domain objects decide() reads.
 *
 * This is the whole seam between Collect and Decide, and it is where the
 * project's recurring bug lives: a column that Notion has no value for must
 * arrive as `null`, never as `0`. The collector is careful to write a real
 * null where it could not read a figure (`_num(None)`); if this file turns
 * that back into a zero, every guard downstream — the confidence bound, the
 * reading floor, the bounce verdict — is reading a measurement that was never
 * taken. `num()` below is the single place that decision is made.
 *
 * One database is enough. History rows already carry `Active Mailboxes` and
 * the compliance snapshot per domain-day, so nothing here needs to read the
 * Mailboxes table.
 *
 * Shapes, as the collector writes them (history_snapshot.py):
 *   Key                  title      "YYYY-MM-DD|domain"
 *   Date                 date
 *   Domain               rich_text
 *   Active Mailboxes     number
 *   Spam Rate            number     percentage POINTS, not a 0..1 rate
 *   DMARC Success Rate   number     percentage points
 *   Message Volume       number     Google's TLS-inbound proxy, NOT a send count
 *   Sent                 number     Mailjet's actual send count
 *   Hard Bounced …       number     counts
 *   Verdict Reason       rich_text
 *   Compliance Issues    rich_text  comma-joined requirement names, all NEEDS_WORK
 */

// ── Notion property readers ────────────────────────────────────────────────

/**
 * A number property, with `null` preserved.
 *
 * Notion gives `null` both for "written as null because we could not read it"
 * and for "never written". Both are genuinely unknown, so both stay null.
 * `undefined` (the column does not exist on this database at all) is the same
 * answer. The one thing this must never do is substitute 0.
 */
const num = p => (p && typeof p.number === 'number' ? p.number : null);

const text = p => (p && Array.isArray(p.rich_text)
  ? p.rich_text.map(x => x.plain_text || '').join('') : '');

const titleText = p => (p && Array.isArray(p.title)
  ? p.title.map(x => x.plain_text || '').join('') : '');

const dateStart = p => (p && p.date && p.date.start ? p.date.start.slice(0, 10) : null);

// ── Row mapping ────────────────────────────────────────────────────────────

/**
 * The domain a row belongs to. The `Domain` column is authoritative; the Key
 * is the fallback, because it is the row's title and therefore always present
 * ("2026-10-27|example.com").
 */
function rowDomain(props) {
  const d = text(props.Domain).trim().toLowerCase();
  if (d) return d;
  const key = titleText(props.Key);
  const bar = key.indexOf('|');
  return bar === -1 ? '' : key.slice(bar + 1).trim().toLowerCase();
}

function toReading(props) {
  return {
    date:         dateStart(props.Date),
    spamRate:     num(props['Spam Rate']),
    authDmarc:    num(props['DMARC Success Rate']),
    volume:       num(props['Message Volume']),
    sent:         num(props.Sent),
    hardBounced:  num(props['Hard Bounced']),
    softBounced:  num(props['Soft Bounced']),
    blocked:      num(props.Blocked),
    unsubscribed: num(props.Unsubscribed),
    deferred:     num(props.Deferred),
    activeMailboxes: num(props['Active Mailboxes']),
  };
}

/**
 * Compliance is a snapshot of NOW stamped on the newest row the collector
 * wrote for a domain, so it is read from the newest row that carries one
 * rather than from the newest row.
 *
 * `Compliance Issues` is a comma-joined list of the requirements Google
 * currently reports as NEEDS_WORK, so every name in it has that status by
 * construction — which is the shape configIssues() reads.
 */
function complianceFrom(rows) {
  for (const r of rows) {                       // newest first
    const reason = text(r.props['Verdict Reason']).trim();
    const issues = text(r.props['Compliance Issues']);
    if (!reason && !issues) continue;
    const requirements = {};
    for (const name of issues.split(',').map(s => s.trim()).filter(Boolean)) {
      requirements[name] = 'NEEDS_WORK';
    }
    return {
      verdict: text(r.props['Compliance Verdict']).trim() || null,
      verdictReason: reason || null,
      requirements,
    };
  }
  return { verdict: null, verdictReason: null, requirements: {} };
}

/**
 * Build decide()'s domain objects from raw Notion pages.
 *
 * `windowDays` bounds how far back readings are taken. The collector keeps 60
 * days; scoring on all of them would let a domain's state be held down by a
 * fortnight it has since recovered from.
 */
function loadDomains(pages, { windowDays = 14, today = null } = {}) {
  const byDomain = new Map();

  for (const pg of pages) {
    const props = pg.properties || {};
    const domain = rowDomain(props);
    const date = dateStart(props.Date);
    if (!domain || !date) continue;             // a row we cannot place is dropped
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ date, props });
  }

  // The cutoff is taken from the data unless a date is given, so a late cron
  // run or a quiet weekend does not silently empty the window.
  const allDates = [...byDomain.values()].flat().map(r => r.date).sort();
  const anchor = today || allDates[allDates.length - 1] || null;
  const cutoff = anchor
    ? new Date(new Date(anchor).getTime() - (windowDays - 1) * 86400000)
        .toISOString().slice(0, 10)
    : null;

  const domains = [];
  for (const [domain, rows] of byDomain) {
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));            // newest first
    const inWindow = cutoff ? rows.filter(r => r.date >= cutoff) : rows;
    if (!inWindow.length) continue;

    // In play = the domain currently has at least one active mailbox. Read
    // from the newest row that states it: a blank means the collector could
    // not say, which is not the same as zero and must not idle the domain.
    let active = null;
    for (const r of rows) {
      const v = num(r.props['Active Mailboxes']);
      if (v !== null) { active = v; break; }
    }

    domains.push({
      domain,
      inPlay: active === null ? true : active > 0,
      activeMailboxes: active,
      readings: inWindow.map(r => toReading(r.props)).filter(r => r.date),
      compliance: complianceFrom(rows),
      windowFrom: cutoff,
      windowThrough: anchor,
    });
  }

  domains.sort((a, b) => (a.domain < b.domain ? -1 : 1));
  return domains;
}

module.exports = { loadDomains, toReading, rowDomain, complianceFrom, num, text, titleText, dateStart };
