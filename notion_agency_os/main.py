"""Main orchestrator and CLI entry point for Notion Agency OS.

Usage:
    python -m notion_agency_os.main discover          # Show database schemas
    python -m notion_agency_os.main dashboard          # Terminal dashboard
    python -m notion_agency_os.main report             # Generate all client reports
    python -m notion_agency_os.main report --client "Acme Corp"  # Single client
    python -m notion_agency_os.main portfolio          # Portfolio-level summary
    python -m notion_agency_os.main write-reports      # Generate & write to Notion
"""

import argparse
import sys

from rich.console import Console

from .config import load_config, AppConfig
from .notion_client import NotionClient
from .aggregator import ClientAggregator
from .report_generator import ReportGenerator
from .dashboard import TerminalDashboard, NotionDashboardWriter

console = Console()


def cmd_discover(config: AppConfig) -> None:
    """Discover and display database schemas to help with property mapping."""
    notion = NotionClient(config)

    databases = {
        "Client Board": config.notion.client_board_db_id,
        "Active Clients": config.notion.active_clients_db_id,
        "Client Feedback": config.notion.client_feedback_db_id,
        "Campaign Performance": config.notion.campaign_performance_db_id,
    }

    for name, db_id in databases.items():
        if not db_id:
            console.print(f"\n[yellow]{name}:[/yellow] No database ID configured — skipping")
            continue

        console.print(f"\n[bold cyan]{name}[/bold cyan] (ID: {db_id})")
        schema = notion.get_database_schema(db_id)
        if not schema:
            console.print("  [dim]No properties found[/dim]")
            continue

        for prop_name, prop_info in sorted(schema.items()):
            console.print(f"  [green]{prop_name}[/green] — {prop_info['type']}")


def cmd_dashboard(config: AppConfig) -> None:
    """Render the terminal dashboard."""
    notion = NotionClient(config)
    aggregator = ClientAggregator(notion)

    console.print("[dim]Fetching client data from Notion...[/dim]")
    profiles = aggregator.aggregate_all_clients()

    if not profiles:
        console.print("[yellow]No clients found. Check your database IDs and property mappings.[/yellow]")
        return

    dashboard = TerminalDashboard()
    dashboard.render_full_dashboard(profiles)


def cmd_report(config: AppConfig, client_name: str | None = None) -> None:
    """Generate AI-powered weekly reports."""
    notion = NotionClient(config)
    aggregator = ClientAggregator(notion)
    generator = ReportGenerator(config)

    if client_name:
        console.print(f"[dim]Generating report for {client_name}...[/dim]")
        profile = aggregator.get_single_client(client_name)
        if not profile:
            console.print(f"[red]Client '{client_name}' not found.[/red]")
            return
        report = generator.generate_client_report(profile)
        console.print(f"\n{report}")
    else:
        profiles = aggregator.aggregate_all_clients()
        if not profiles:
            console.print("[yellow]No clients found.[/yellow]")
            return

        for profile in profiles:
            console.print(f"\n[dim]Generating report for {profile.name}...[/dim]")
            report = generator.generate_client_report(profile)
            console.print(f"\n{report}")
            console.print("[dim]" + "=" * 80 + "[/dim]")


def cmd_portfolio(config: AppConfig) -> None:
    """Generate a portfolio-level executive summary."""
    notion = NotionClient(config)
    aggregator = ClientAggregator(notion)
    generator = ReportGenerator(config)

    console.print("[dim]Generating portfolio summary...[/dim]")
    profiles = aggregator.aggregate_all_clients()

    if not profiles:
        console.print("[yellow]No clients found.[/yellow]")
        return

    summary = generator.generate_portfolio_summary(profiles)
    console.print(f"\n{summary}")


def cmd_write_reports(config: AppConfig) -> None:
    """Generate reports and write them back to Notion."""
    notion = NotionClient(config)
    aggregator = ClientAggregator(notion)
    generator = ReportGenerator(config)
    writer = NotionDashboardWriter(notion)

    profiles = aggregator.aggregate_all_clients()
    if not profiles:
        console.print("[yellow]No clients found.[/yellow]")
        return

    for profile in profiles:
        console.print(f"[dim]Generating report for {profile.name}...[/dim]")
        report = generator.generate_client_report(profile)

        output = config.report_output_format.lower()

        if output in ("notion", "both") and profile.page_id:
            console.print(f"[dim]Writing report to Notion page for {profile.name}...[/dim]")
            writer.write_report_to_page(profile.page_id, report)
            console.print(f"[green]Report written to Notion for {profile.name}[/green]")

        if output in ("console", "both"):
            console.print(f"\n{report}")
            console.print("[dim]" + "=" * 80 + "[/dim]")

    console.print("\n[bold green]All reports generated.[/bold green]")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Notion Agency OS — Client Intelligence & Reporting",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Commands:
  discover       Show Notion database schemas (helps map property names)
  dashboard      Render a terminal-based performance dashboard
  report         Generate AI-powered weekly client reports
  portfolio      Generate a portfolio-level executive summary
  write-reports  Generate reports and write them to Notion pages

Examples:
  python -m notion_agency_os.main discover
  python -m notion_agency_os.main dashboard
  python -m notion_agency_os.main report --client "Acme Corp"
  python -m notion_agency_os.main write-reports
""",
    )
    parser.add_argument("command", choices=["discover", "dashboard", "report", "portfolio", "write-reports"])
    parser.add_argument("--client", type=str, default=None, help="Client name (for single-client report)")

    args = parser.parse_args()

    try:
        config = load_config()
    except ValueError as e:
        console.print(f"[red]Configuration error: {e}[/red]")
        console.print("[dim]Copy .env.example to .env and fill in your API keys and database IDs.[/dim]")
        sys.exit(1)

    match args.command:
        case "discover":
            cmd_discover(config)
        case "dashboard":
            cmd_dashboard(config)
        case "report":
            cmd_report(config, client_name=args.client)
        case "portfolio":
            cmd_portfolio(config)
        case "write-reports":
            cmd_write_reports(config)


if __name__ == "__main__":
    main()
