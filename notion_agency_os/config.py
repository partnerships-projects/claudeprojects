"""Configuration management for Notion Agency OS."""

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv


@dataclass
class NotionConfig:
    api_key: str
    client_board_db_id: str
    active_clients_db_id: str
    client_feedback_db_id: str
    campaign_performance_db_id: str = ""


@dataclass
class AnthropicConfig:
    api_key: str
    model: str = "claude-opus-4-6"


@dataclass
class AppConfig:
    notion: NotionConfig
    anthropic: AnthropicConfig
    report_output_format: str = "both"

    # Property name mappings for Notion databases.
    # Update these to match your actual Notion property names.
    client_board_properties: dict = field(default_factory=lambda: {
        "name": "Name",
        "status": "Status",
        "assigned_to": "Assigned To",
        "priority": "Priority",
        "tags": "Tags",
    })

    active_client_properties: dict = field(default_factory=lambda: {
        "name": "Client Name",
        "account_manager": "AM",
        "contract_date": "Contract Date",
        "invoice": "Invoice",
        "plan": "Plan",
        "hours_per_week": "Hours/Week",
        "churn_status": "Churn Status",
        "retainer": "Retainer",
        "invoice_collection": "Invoice Collection",
        "monthly_revenue": "Monthly Revenue",
        "notes": "Notes",
    })

    feedback_properties: dict = field(default_factory=lambda: {
        "client_name": "Client Name",
        "meeting_date": "Meeting Date",
        "recap": "Recap",
        "sentiment": "Sentiment",
        "action_items": "Action Items",
        "attendees": "Attendees",
    })

    campaign_properties: dict = field(default_factory=lambda: {
        "client_name": "Client Name",
        "campaign_name": "Campaign Name",
        "platform": "Platform",
        "spend": "Spend",
        "impressions": "Impressions",
        "clicks": "Clicks",
        "conversions": "Conversions",
        "revenue": "Revenue",
        "date_range": "Date Range",
        "status": "Status",
    })


def load_config() -> AppConfig:
    """Load configuration from environment variables."""
    load_dotenv()

    notion_api_key = os.getenv("NOTION_API_KEY", "")
    anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")

    if not notion_api_key:
        raise ValueError("NOTION_API_KEY is required. Set it in .env file.")
    if not anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY is required. Set it in .env file.")

    return AppConfig(
        notion=NotionConfig(
            api_key=notion_api_key,
            client_board_db_id=os.getenv("NOTION_CLIENT_BOARD_DB_ID", ""),
            active_clients_db_id=os.getenv("NOTION_ACTIVE_CLIENTS_DB_ID", ""),
            client_feedback_db_id=os.getenv("NOTION_CLIENT_FEEDBACK_DB_ID", ""),
            campaign_performance_db_id=os.getenv("NOTION_CAMPAIGN_PERFORMANCE_DB_ID", ""),
        ),
        anthropic=AnthropicConfig(
            api_key=anthropic_api_key,
        ),
        report_output_format=os.getenv("REPORT_OUTPUT_FORMAT", "both"),
    )
