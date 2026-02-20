"""Campaign performance dashboard module.

Provides both a terminal-based dashboard (via Rich) and the ability
to write a structured dashboard page back into Notion.
"""

from datetime import datetime

from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.columns import Columns
from rich.text import Text

from .aggregator import ClientProfile, CampaignData
from .notion_client import NotionClient


class TerminalDashboard:
    """Renders campaign and client performance data in the terminal."""

    def __init__(self):
        self.console = Console()

    def _roas_color(self, roas: float | None) -> str:
        if roas is None:
            return "dim"
        if roas >= 3.0:
            return "green"
        if roas >= 2.0:
            return "yellow"
        return "red"

    def _sentiment_color(self, sentiment: str | None) -> str:
        if not sentiment:
            return "dim"
        s = sentiment.lower()
        if "positive" in s or "happy" in s or "great" in s:
            return "green"
        if "neutral" in s or "ok" in s:
            return "yellow"
        return "red"

    def render_portfolio_overview(self, profiles: list[ClientProfile]) -> None:
        """Render a high-level portfolio table."""
        table = Table(
            title="Agency Portfolio Overview",
            show_header=True,
            header_style="bold cyan",
        )
        table.add_column("Client", style="bold")
        table.add_column("Status")
        table.add_column("Plan")
        table.add_column("MRR", justify="right")
        table.add_column("Churn Risk")
        table.add_column("Sentiment")
        table.add_column("Campaigns")
        table.add_column("ROAS", justify="right")

        total_mrr = 0.0
        for p in profiles:
            mrr = p.monthly_revenue or 0
            total_mrr += mrr

            roas_str = f"{p.overall_roas:.1f}x" if p.overall_roas else "-"
            active_campaigns = len([c for c in p.campaigns if c.status and "active" in c.status.lower()])

            churn_style = "red" if p.churn_status and "risk" in (p.churn_status or "").lower() else "green"
            sentiment_style = self._sentiment_color(p.latest_sentiment)
            roas_style = self._roas_color(p.overall_roas)

            table.add_row(
                p.name,
                p.board_status or "-",
                p.plan or "-",
                f"${mrr:,.0f}" if mrr else "-",
                Text(p.churn_status or "OK", style=churn_style),
                Text(p.latest_sentiment or "-", style=sentiment_style),
                f"{active_campaigns}/{len(p.campaigns)}",
                Text(roas_str, style=roas_style),
            )

        table.add_section()
        table.add_row(
            Text("TOTAL", style="bold"),
            "", "", Text(f"${total_mrr:,.0f}", style="bold"), "", "", "", "",
        )

        self.console.print()
        self.console.print(table)

    def render_campaign_detail(self, profile: ClientProfile) -> None:
        """Render detailed campaign breakdown for a single client."""
        if not profile.campaigns:
            self.console.print(f"\n[dim]No campaign data for {profile.name}[/dim]")
            return

        table = Table(
            title=f"Campaign Performance — {profile.name}",
            show_header=True,
            header_style="bold magenta",
        )
        table.add_column("Campaign")
        table.add_column("Platform")
        table.add_column("Status")
        table.add_column("Spend", justify="right")
        table.add_column("Impressions", justify="right")
        table.add_column("Clicks", justify="right")
        table.add_column("CTR", justify="right")
        table.add_column("Conv.", justify="right")
        table.add_column("Revenue", justify="right")
        table.add_column("ROAS", justify="right")

        for c in profile.campaigns:
            roas_str = f"{c.roas:.1f}x" if c.roas else "-"
            ctr_str = f"{c.ctr:.1f}%" if c.ctr else "-"
            roas_style = self._roas_color(c.roas)

            table.add_row(
                c.campaign_name or "-",
                c.platform or "-",
                c.status or "-",
                f"${c.spend:,.0f}" if c.spend else "-",
                f"{c.impressions:,}" if c.impressions else "-",
                f"{c.clicks:,}" if c.clicks else "-",
                ctr_str,
                f"{c.conversions:,}" if c.conversions else "-",
                f"${c.revenue:,.0f}" if c.revenue else "-",
                Text(roas_str, style=roas_style),
            )

        self.console.print()
        self.console.print(table)

    def render_client_health(self, profile: ClientProfile) -> None:
        """Render a health card for a single client."""
        signals = profile.health_signals

        items = []
        items.append(f"[bold]{profile.name}[/bold]")
        items.append(f"Status: {profile.board_status or 'N/A'}")
        items.append(f"Plan: {profile.plan or 'N/A'}")
        items.append(f"AM: {profile.account_manager or 'N/A'}")
        items.append(f"Hours/Week: {profile.hours_per_week or 'N/A'}")
        items.append(f"MRR: ${profile.monthly_revenue:,.0f}" if profile.monthly_revenue else "MRR: N/A")
        items.append(f"Churn: {signals.get('churn_status', 'OK')}")

        if "campaign_alert" in signals:
            items.append(f"[red]{signals['campaign_alert']}[/red]")

        if profile.latest_sentiment:
            style = self._sentiment_color(profile.latest_sentiment)
            items.append(f"Sentiment: [{style}]{profile.latest_sentiment}[/{style}]")

        self.console.print(Panel(
            "\n".join(items),
            title=f"{profile.name}",
            border_style="cyan",
            width=50,
        ))

    def render_full_dashboard(self, profiles: list[ClientProfile]) -> None:
        """Render the complete terminal dashboard."""
        now = datetime.now().strftime("%B %d, %Y %H:%M")
        self.console.print(f"\n[bold cyan]Agency OS Dashboard[/bold cyan] — {now}\n")

        self.render_portfolio_overview(profiles)

        # Health cards
        self.console.print("\n[bold]Client Health Cards[/bold]")
        cards = []
        for p in profiles:
            self.render_client_health(p)

        # Campaign detail for each client with campaigns
        for p in profiles:
            if p.campaigns:
                self.render_campaign_detail(p)


class NotionDashboardWriter:
    """Writes dashboard/report data back to Notion pages."""

    def __init__(self, notion: NotionClient):
        self.notion = notion

    def _markdown_to_blocks(self, markdown: str) -> list[dict]:
        """Convert markdown text into Notion block objects."""
        blocks = []
        for line in markdown.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue

            if stripped.startswith("### "):
                blocks.append({
                    "object": "block",
                    "type": "heading_3",
                    "heading_3": {
                        "rich_text": [{"type": "text", "text": {"content": stripped[4:]}}]
                    },
                })
            elif stripped.startswith("## "):
                blocks.append({
                    "object": "block",
                    "type": "heading_2",
                    "heading_2": {
                        "rich_text": [{"type": "text", "text": {"content": stripped[3:]}}]
                    },
                })
            elif stripped.startswith("# "):
                blocks.append({
                    "object": "block",
                    "type": "heading_1",
                    "heading_1": {
                        "rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]
                    },
                })
            elif stripped.startswith("- ") or stripped.startswith("* "):
                blocks.append({
                    "object": "block",
                    "type": "bulleted_list_item",
                    "bulleted_list_item": {
                        "rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]
                    },
                })
            else:
                # Paragraph — Notion has a 2000-char limit per rich_text element
                content = stripped
                chunks = [content[i:i+2000] for i in range(0, len(content), 2000)]
                blocks.append({
                    "object": "block",
                    "type": "paragraph",
                    "paragraph": {
                        "rich_text": [
                            {"type": "text", "text": {"content": chunk}}
                            for chunk in chunks
                        ]
                    },
                })

        return blocks

    def write_report_to_page(self, page_id: str, report_markdown: str) -> None:
        """Append a weekly report to an existing client's Notion page."""
        # Add a divider before the report
        blocks = [{"object": "block", "type": "divider", "divider": {}}]
        blocks.extend(self._markdown_to_blocks(report_markdown))
        self.notion.append_blocks(page_id, blocks)

    def create_report_page(self, database_id: str, client_name: str,
                           report_markdown: str) -> dict:
        """Create a standalone report page in a Notion database."""
        today = datetime.now().strftime("%Y-%m-%d")
        title = f"{client_name} — Weekly Report {today}"

        properties = {
            "Name": {
                "title": [{"text": {"content": title}}]
            },
        }

        children = self._markdown_to_blocks(report_markdown)
        return self.notion.create_page(database_id, properties, children=children)
