// =============================================================================
// n8n Code Node — Saleshandy Domain Health & Email Account Map
// Paste into: Code Node (JavaScript) → "Run Once for All Items" mode
//
// IMPORTANT: Replace YOUR_API_KEY with your actual Saleshandy API key.
//            Better yet, store it in n8n Credentials or environment variables.
// =============================================================================

const API_KEY = "YOUR_API_KEY"; // <-- Replace this (or use $env.SALESHANDY_API_KEY)
const BASE_URL = "https://open-api.saleshandy.com/v1";

// ---------------------------------------------------------------------------
// Step 1: Fetch all sequences
// ---------------------------------------------------------------------------
let sequences = [];
try {
  const seqResponse = await this.helpers.httpRequest({
    method: "GET",
    url: `${BASE_URL}/sequences`,
    headers: {
      "x-api-key": API_KEY,
    },
    json: true,
  });

  sequences = seqResponse.data || seqResponse.sequences || seqResponse || [];
} catch (err) {
  sequences = [];
  console.log("Sequences fetch error:", err.message);
}

// ---------------------------------------------------------------------------
// Step 2: Paginate through all email accounts
// ---------------------------------------------------------------------------
const allEmails = [];
let page = 1;
let hasMore = true;

while (hasMore) {
  try {
    const response = await this.helpers.httpRequest({
      method: "GET",
      url: `${BASE_URL}/email-accounts`,
      qs: {
        page,
        limit: 100,
      },
      headers: {
        "x-api-key": API_KEY,
      },
      json: true,
    });

    const accounts = response.data || response.emailAccounts || [];

    if (!Array.isArray(accounts) || accounts.length === 0) {
      hasMore = false;
      break;
    }

    allEmails.push(...accounts);
    hasMore = accounts.length === 100;
    page++;
  } catch (err) {
    console.log(`Email accounts fetch error on page ${page}:`, err.message);
    hasMore = false;
  }
}

// ---------------------------------------------------------------------------
// Step 3: Build domain map with health scores
// ---------------------------------------------------------------------------
const domainMap = {};

for (const account of allEmails) {
  const email = account.email || account.fromEmail || "";
  const domain = email.split("@")[1];

  if (!domain) continue;

  if (!domainMap[domain]) {
    domainMap[domain] = {
      accounts: [],
      totalAccounts: 0,
      avgHealthScore: 0,
      healthScores: [],
    };
  }

  const healthScore = account.healthScore
    || account.health_score
    || account.emailHealth
    || 0;

  domainMap[domain].accounts.push({
    email: email,
    healthScore: healthScore,
    fromName: account.fromName || account.from_name || "",
    status: account.status || "unknown",
    dailyLimit: account.dailyLimit || account.daily_limit || null,
    sentToday: account.sentToday || account.sent_today || null,
  });

  domainMap[domain].totalAccounts++;
  domainMap[domain].healthScores.push(healthScore);
}

// Calculate averages per domain
for (const domain of Object.keys(domainMap)) {
  const scores = domainMap[domain].healthScores;
  domainMap[domain].avgHealthScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  // Clean up temp array
  delete domainMap[domain].healthScores;
}

// ---------------------------------------------------------------------------
// Step 4: Build summary
// ---------------------------------------------------------------------------
const allHealthScores = allEmails
  .map(e => e.healthScore || e.health_score || 0)
  .filter(s => s > 0);

const avgOverallHealth = allHealthScores.length > 0
  ? Math.round(allHealthScores.reduce((a, b) => a + b, 0) / allHealthScores.length)
  : 0;

const domainSummary = Object.entries(domainMap)
  .map(([domain, data]) => ({
    domain,
    totalAccounts: data.totalAccounts,
    avgHealthScore: data.avgHealthScore,
    status: data.avgHealthScore >= 90 ? "excellent"
      : data.avgHealthScore >= 80 ? "good"
      : data.avgHealthScore >= 70 ? "warning"
      : "critical",
  }))
  .sort((a, b) => b.avgHealthScore - a.avgHealthScore);

// ---------------------------------------------------------------------------
// Step 5: Return n8n-compatible output
// ---------------------------------------------------------------------------
return [
  {
    json: {
      reportDate: new Date().toISOString(),
      totalEmailAccounts: allEmails.length,
      totalDomains: Object.keys(domainMap).length,
      avgOverallHealthScore: avgOverallHealth,
      totalSequences: Array.isArray(sequences) ? sequences.length : 0,
      sequences: sequences,
      domainSummary: domainSummary,
      domainMap: domainMap,
    },
  },
];
