'use strict';
/**
 * The smallest Notion client this needs: query a database, follow the cursor.
 *
 * Read-only on purpose. Decide proposes and a human decides, so nothing in
 * this path has any reason to hold a write method — and a tool that cannot
 * write cannot write to the wrong database at three in the morning.
 */

const NOTION_VERSION = '2022-06-28';
const BASE = 'https://api.notion.com/v1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function token() {
  const t = (process.env.NOTION_TOKEN || '').trim();
  if (!t) {
    throw new Error(
      'NOTION_TOKEN is not set. Decide reads the Domain Health History database ' +
      'and cannot run without it. Set it as a GitHub Actions secret, never in ' +
      'the environment variables field.');
  }
  return t;
}

/**
 * One request, with retries for the failures that are worth retrying.
 *
 * 429 and 5xx are transient and are retried with backoff; Notion sends
 * Retry-After on 429 and it is honoured, because guessing shorter than it says
 * is how a rate limit becomes a ban. Everything else — a bad token, a database
 * the integration cannot see, a malformed filter — is a fact about the request
 * and is raised immediately rather than retried four times first.
 */
async function request(path, body, { attempts = 5 } = {}) {
  let wait = 1000;
  for (let i = 1; ; i++) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const retriable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => '');
    if (!retriable || i >= attempts) {
      throw new Error(`Notion ${res.status} on ${path}: ${detail.slice(0, 400)}`);
    }
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : wait);
    wait *= 2;
  }
}

/**
 * Every page of a database query, oldest cursor first.
 *
 * `onPage` reports progress so a long read is not a silent one. The 350ms
 * pause keeps this under Notion's ~3 requests/second average; a 14-day window
 * over this fleet is roughly 30 requests, so the pause costs ten seconds and
 * buys never being the reason the collector gets throttled.
 */
async function queryAll(databaseId, { filter, pageSize = 100, onPage = null } = {}) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: pageSize };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;

    const res = await request(`/databases/${databaseId}/query`, body);
    out.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
    if (onPage) onPage(out.length, !!cursor);
    if (cursor) await sleep(350);
  } while (cursor);
  return out;
}

/** History rows dated on or after `since` (YYYY-MM-DD). */
function historyRows(databaseId, since, opts = {}) {
  return queryAll(databaseId, {
    filter: { property: 'Date', date: { on_or_after: since } },
    ...opts,
  });
}

module.exports = { queryAll, historyRows, request, NOTION_VERSION };
