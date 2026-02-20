"""Client data aggregation module.

Combines data from all Notion databases into a unified client profile
that can be used for report generation and dashboard views.
"""

from dataclasses import dataclass, field
from datetime import datetime

from .notion_client import NotionClient


@dataclass
class CampaignData:
    campaign_name: str
    platform: str
    spend: float | None
    impressions: int | None
    clicks: int | None
    conversions: int | None
    revenue: float | None
    date_range: str | None
    status: str | None

    @property
    def ctr(self) -> float | None:
        if self.impressions and self.clicks:
            return round((self.clicks / self.impressions) * 100, 2)
        return None

    @property
    def cpc(self) -> float | None:
        if self.spend and self.clicks:
            return round(self.spend / self.clicks, 2)
        return None

    @property
    def roas(self) -> float | None:
        if self.spend and self.revenue and self.spend > 0:
            return round(self.revenue / self.spend, 2)
        return None


@dataclass
class FeedbackEntry:
    meeting_date: str | None
    recap: str | None
    sentiment: str | None
    action_items: str | None
    attendees: str | list | None


@dataclass
class ClientProfile:
    """Unified client profile aggregating all data sources."""
    name: str
    page_id: str | None = None
    url: str | None = None

    # From Client Board
    board_status: str | None = None
    priority: str | None = None
    assigned_to: str | list | None = None
    tags: list | None = None

    # From Active Clients Table
    account_manager: str | list | None = None
    contract_date: str | None = None
    invoice: str | None = None
    plan: str | None = None
    hours_per_week: float | None = None
    churn_status: str | None = None
    retainer: float | None = None
    invoice_collection: str | None = None
    monthly_revenue: float | None = None
    notes: str | None = None

    # Aggregated data
    feedback: list[FeedbackEntry] = field(default_factory=list)
    campaigns: list[CampaignData] = field(default_factory=list)

    @property
    def total_campaign_spend(self) -> float:
        return sum(c.spend or 0 for c in self.campaigns)

    @property
    def total_campaign_revenue(self) -> float:
        return sum(c.revenue or 0 for c in self.campaigns)

    @property
    def overall_roas(self) -> float | None:
        if self.total_campaign_spend > 0:
            return round(self.total_campaign_revenue / self.total_campaign_spend, 2)
        return None

    @property
    def latest_feedback(self) -> FeedbackEntry | None:
        return self.feedback[0] if self.feedback else None

    @property
    def latest_sentiment(self) -> str | None:
        for fb in self.feedback:
            if fb.sentiment:
                return fb.sentiment
        return None

    @property
    def health_signals(self) -> dict:
        """Compute client health signals from available data."""
        signals = {}

        # Churn risk
        if self.churn_status:
            signals["churn_status"] = self.churn_status

        # Sentiment trend from recent feedback
        sentiments = [fb.sentiment for fb in self.feedback[:4] if fb.sentiment]
        if sentiments:
            signals["recent_sentiments"] = sentiments

        # Campaign performance
        if self.overall_roas is not None:
            signals["overall_roas"] = self.overall_roas
            if self.overall_roas < 1.0:
                signals["campaign_alert"] = "ROAS below 1.0 — campaigns losing money"
            elif self.overall_roas < 2.0:
                signals["campaign_alert"] = "ROAS below 2.0 — underperforming"

        # Invoice collection
        if self.invoice_collection:
            signals["invoice_collection"] = self.invoice_collection

        return signals

    def to_summary_dict(self) -> dict:
        """Convert profile to a flat summary dict for report generation."""
        return {
            "client_name": self.name,
            "board_status": self.board_status,
            "priority": self.priority,
            "account_manager": self.account_manager,
            "plan": self.plan,
            "hours_per_week": self.hours_per_week,
            "retainer": self.retainer,
            "monthly_revenue": self.monthly_revenue,
            "churn_status": self.churn_status,
            "invoice_collection": self.invoice_collection,
            "contract_date": self.contract_date,
            "total_campaign_spend": self.total_campaign_spend,
            "total_campaign_revenue": self.total_campaign_revenue,
            "overall_roas": self.overall_roas,
            "active_campaigns": len([c for c in self.campaigns if c.status and "active" in c.status.lower()]),
            "total_campaigns": len(self.campaigns),
            "latest_sentiment": self.latest_sentiment,
            "feedback_count_recent": len(self.feedback),
            "latest_feedback_recap": self.latest_feedback.recap if self.latest_feedback else None,
            "latest_feedback_action_items": self.latest_feedback.action_items if self.latest_feedback else None,
            "health_signals": self.health_signals,
            "campaigns": [
                {
                    "name": c.campaign_name,
                    "platform": c.platform,
                    "spend": c.spend,
                    "impressions": c.impressions,
                    "clicks": c.clicks,
                    "conversions": c.conversions,
                    "revenue": c.revenue,
                    "ctr": c.ctr,
                    "cpc": c.cpc,
                    "roas": c.roas,
                    "status": c.status,
                }
                for c in self.campaigns
            ],
            "recent_feedback": [
                {
                    "date": fb.meeting_date,
                    "recap": fb.recap,
                    "sentiment": fb.sentiment,
                    "action_items": fb.action_items,
                }
                for fb in self.feedback[:5]
            ],
        }


def _normalize_name(name: str | None) -> str:
    """Normalize a client name for matching across databases."""
    if not name:
        return ""
    return name.strip().lower()


class ClientAggregator:
    """Aggregates client data from all Notion databases into unified profiles."""

    def __init__(self, notion: NotionClient):
        self.notion = notion

    def aggregate_all_clients(self, feedback_days_back: int = 14) -> list[ClientProfile]:
        """Pull data from all databases and build unified client profiles."""
        # Fetch from all sources
        board_entries = self.notion.get_client_board()
        active_entries = self.notion.get_active_clients()
        feedback_entries = self.notion.get_client_feedback(days_back=feedback_days_back)
        campaign_entries = self.notion.get_campaign_performance()

        # Build profiles keyed by normalized name
        profiles: dict[str, ClientProfile] = {}

        # 1. Seed from Active Clients (primary source)
        for entry in active_entries:
            name = entry.get("name") or ""
            key = _normalize_name(name)
            if not key:
                continue

            profiles[key] = ClientProfile(
                name=name,
                page_id=entry.get("_page_id"),
                url=entry.get("_url"),
                account_manager=entry.get("account_manager"),
                contract_date=entry.get("contract_date"),
                invoice=entry.get("invoice"),
                plan=entry.get("plan"),
                hours_per_week=entry.get("hours_per_week"),
                churn_status=entry.get("churn_status"),
                retainer=entry.get("retainer"),
                invoice_collection=entry.get("invoice_collection"),
                monthly_revenue=entry.get("monthly_revenue"),
                notes=entry.get("notes"),
            )

        # 2. Merge Client Board data
        for entry in board_entries:
            name = entry.get("name") or ""
            key = _normalize_name(name)
            if not key:
                continue

            if key not in profiles:
                profiles[key] = ClientProfile(name=name)

            profiles[key].board_status = entry.get("status")
            profiles[key].priority = entry.get("priority")
            profiles[key].assigned_to = entry.get("assigned_to")
            profiles[key].tags = entry.get("tags")

        # 3. Attach feedback
        for entry in feedback_entries:
            client_name = entry.get("client_name") or ""
            key = _normalize_name(client_name)
            if not key or key not in profiles:
                # If client not found, create a minimal profile
                if key:
                    profiles[key] = ClientProfile(name=client_name)
                else:
                    continue

            profiles[key].feedback.append(FeedbackEntry(
                meeting_date=entry.get("meeting_date"),
                recap=entry.get("recap"),
                sentiment=entry.get("sentiment"),
                action_items=entry.get("action_items"),
                attendees=entry.get("attendees"),
            ))

        # 4. Attach campaign data
        for entry in campaign_entries:
            client_name = entry.get("client_name") or ""
            key = _normalize_name(client_name)
            if not key or key not in profiles:
                if key:
                    profiles[key] = ClientProfile(name=client_name)
                else:
                    continue

            profiles[key].campaigns.append(CampaignData(
                campaign_name=entry.get("campaign_name") or "",
                platform=entry.get("platform") or "",
                spend=entry.get("spend"),
                impressions=int(entry.get("impressions") or 0) if entry.get("impressions") else None,
                clicks=int(entry.get("clicks") or 0) if entry.get("clicks") else None,
                conversions=int(entry.get("conversions") or 0) if entry.get("conversions") else None,
                revenue=entry.get("revenue"),
                date_range=entry.get("date_range"),
                status=entry.get("status"),
            ))

        return sorted(profiles.values(), key=lambda p: p.name)

    def get_single_client(self, client_name: str, feedback_days_back: int = 14) -> ClientProfile | None:
        """Build a profile for a single client by name."""
        all_profiles = self.aggregate_all_clients(feedback_days_back=feedback_days_back)
        key = _normalize_name(client_name)
        for profile in all_profiles:
            if _normalize_name(profile.name) == key:
                return profile
        return None
