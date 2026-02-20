"""AI-powered weekly report generator using Claude.

Generates per-client weekly summaries by feeding aggregated data
to Claude, which produces an executive-level situation report.
"""

import json
from datetime import datetime

import anthropic

from .aggregator import ClientProfile
from .config import AppConfig


SYSTEM_PROMPT = """\
You are an Agency Operations Analyst. You receive structured data about agency \
clients and produce concise, actionable weekly situation reports.

Your reports should be written so that anyone reading them—account managers, \
agency leadership, or project leads—immediately understands the current state \
of the client relationship and what needs attention.

Format your report using these sections:

## {Client Name} — Weekly Report ({date})

### Status at a Glance
A 2-3 sentence executive summary. Lead with the most important thing \
(good or bad). Include the board status and plan tier.

### Account Health
- Churn risk assessment (based on churn_status, sentiment, engagement)
- Invoice/payment status
- Hours utilization vs contracted hours

### Campaign Performance
- Summary of active campaigns with key metrics (spend, ROAS, CTR)
- Flag any underperforming campaigns (ROAS < 2.0)
- Highlight wins (top performers)

### Recent Feedback & Meetings
- Key themes from recent meeting recaps
- Client sentiment trend
- Outstanding action items

### Flags & Recommendations
- Concrete next steps ranked by priority
- Any risks that need immediate attention
- Upsell or expansion opportunities if applicable

Rules:
- Be direct and specific. No filler.
- Use numbers when available (dollars, percentages, ratios).
- If data is missing for a section, say "No data available" — don't fabricate.
- Keep the total report under 500 words.
- Use bullet points for scanability.
"""


class ReportGenerator:
    """Generates AI-powered weekly client reports using Claude."""

    def __init__(self, config: AppConfig):
        self.client = anthropic.Anthropic(api_key=config.anthropic.api_key)
        self.model = config.anthropic.model

    def generate_client_report(self, profile: ClientProfile) -> str:
        """Generate a weekly report for a single client."""
        summary_data = profile.to_summary_dict()
        today = datetime.now().strftime("%B %d, %Y")

        user_message = (
            f"Generate a weekly situation report for this client. "
            f"Today's date is {today}.\n\n"
            f"Client Data:\n```json\n{json.dumps(summary_data, indent=2, default=str)}\n```"
        )

        with self.client.messages.stream(
            model=self.model,
            max_tokens=4096,
            thinking={"type": "adaptive"},
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        ) as stream:
            response = stream.get_final_message()

        # Extract text from response, skipping thinking blocks
        parts = []
        for block in response.content:
            if block.type == "text":
                parts.append(block.text)

        return "\n".join(parts)

    def generate_portfolio_summary(self, profiles: list[ClientProfile]) -> str:
        """Generate a high-level portfolio summary across all clients."""
        portfolio_data = {
            "total_clients": len(profiles),
            "report_date": datetime.now().strftime("%B %d, %Y"),
            "clients": [],
        }

        for p in profiles:
            portfolio_data["clients"].append({
                "name": p.name,
                "status": p.board_status,
                "plan": p.plan,
                "monthly_revenue": p.monthly_revenue,
                "churn_status": p.churn_status,
                "latest_sentiment": p.latest_sentiment,
                "overall_roas": p.overall_roas,
                "active_campaigns": len([c for c in p.campaigns if c.status and "active" in c.status.lower()]),
                "health_signals": p.health_signals,
            })

        # Calculate totals
        total_mrr = sum(p.monthly_revenue or 0 for p in profiles)
        at_risk = [p.name for p in profiles if p.churn_status and "risk" in (p.churn_status or "").lower()]
        portfolio_data["total_mrr"] = total_mrr
        portfolio_data["at_risk_clients"] = at_risk

        user_message = (
            "Generate a portfolio-level executive summary for the agency. "
            "Highlight the overall health, revenue, at-risk clients, and top priorities.\n\n"
            f"Portfolio Data:\n```json\n{json.dumps(portfolio_data, indent=2, default=str)}\n```"
        )

        portfolio_system = """\
You are an Agency Operations Analyst producing a portfolio-level executive summary.

Format:
## Agency Portfolio Summary — {date}

### Key Metrics
- Total MRR, client count, at-risk count

### Client Health Overview
- Table or list of each client with status, sentiment, ROAS
- Flag any requiring immediate attention

### Top Priorities This Week
- Ranked list of 3-5 actions across the portfolio

### Revenue & Growth
- MRR trends, upsell opportunities, churn risks

Keep it under 400 words. Be data-driven and actionable.
"""

        with self.client.messages.stream(
            model=self.model,
            max_tokens=4096,
            thinking={"type": "adaptive"},
            system=portfolio_system,
            messages=[{"role": "user", "content": user_message}],
        ) as stream:
            response = stream.get_final_message()

        parts = []
        for block in response.content:
            if block.type == "text":
                parts.append(block.text)

        return "\n".join(parts)
