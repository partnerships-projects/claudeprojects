# Fix: Extract Domains Node — n8n Slack Domain Health Workflow

## What Was Broken

The `Extract Domains` Code node used a regex that expected domain + spam rate on **the same line**:
```
*example.com* ... Spam: 4.2%
```

But the actual Gappie message format has them on **separate lines**:
```
🔹 personaforcreators.com
– 🔴 Spam Rate increased to 21.4%
```

Three mismatches:
1. Domain and spam rate are on **different lines**
2. Text says `Spam Rate increased to X%`, not `Spam: X%`
3. Unicode emoji characters prefix the lines

## How to Apply in n8n

### Option A: Import the workflow JSON
1. Open n8n
2. Go to **Workflows → Import from File**
3. Select `n8n-slack-domain-health-workflow.json`
4. Replace `YOUR_CHANNEL_ID` with your actual Slack channel ID
5. Update the credential references to match your existing Slack credentials

### Option B: Fix the existing node manually
1. Open your existing workflow
2. Double-click the **Extract Domains** Code node
3. Replace ALL the JavaScript with the code below:

```javascript
const text = items[0].json.text || items[0].json.message?.text || "";

// Only process Postmaster Notification messages (prevents bot reply loop)
if (!text.includes("Postmaster Notification")) {
  return [{ json: { flaggedDomains: [], skipped: true, reason: "Not a Postmaster Notification" } }];
}

const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
const domains = [];

for (let i = 0; i < lines.length; i++) {
  // Match lines ending with a domain (strips leading emoji/whitespace/punctuation)
  const domainMatch = lines[i].match(/([a-zA-Z0-9][a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}$/);
  if (domainMatch && i + 1 < lines.length) {
    const domain = domainMatch[0].toLowerCase();
    // Next line should contain "Spam Rate increased/decreased to X.X%"
    const spamMatch = lines[i + 1].match(/Spam\s+Rate\s+(?:decreased|increased)\s+to\s+([\d.]+)%/i);
    if (spamMatch) {
      domains.push({
        domain: domain,
        spamRate: parseFloat(spamMatch[1]),
        direction: lines[i + 1].toLowerCase().includes("increased") ? "increased" : "decreased"
      });
      i++; // skip the spam rate line
    }
  }
}

return [{ json: { flaggedDomains: domains } }];
```

## Also Fixed: Bot Reply Loop Prevention

The `"Postmaster Notification"` check at the top ensures the workflow only processes Gappie's domain health messages — **not** the reply the workflow itself posts back to Slack. Without this, the workflow would trigger on its own replies in an infinite loop.

## Reminder: Register the Webhook

The Slack Trigger requires a registered webhook. In n8n:
1. Open the workflow
2. Click the **Slack Trigger** node
3. Click **Listen for Test Event** (this registers the webhook URL with Slack)
4. Post a test message in the monitored channel
5. Once you see data come through, **activate the workflow** (toggle at top-right)

## Note About Bot Messages

Since Gappie posts as a **bot**, make sure your Slack App's Event Subscriptions include `message.channels` and that the bot token has the `channels:history` scope. Without this, bot messages won't trigger the webhook.
