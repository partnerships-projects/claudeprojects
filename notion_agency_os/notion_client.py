"""Notion API client wrapper for Agency OS.

Handles all communication with the Notion API, including querying databases,
reading pages, and writing reports back to Notion.
"""

from datetime import datetime, timedelta
from notion_client import Client as NotionSDKClient

from .config import AppConfig


class NotionClient:
    """Wrapper around the Notion SDK for agency-specific operations."""

    def __init__(self, config: AppConfig):
        self.client = NotionSDKClient(auth=config.notion.api_key)
        self.config = config
        self.db_ids = config.notion

    def _extract_property(self, prop: dict) -> str | float | bool | list | None:
        """Extract a readable value from a Notion property object."""
        prop_type = prop.get("type", "")

        match prop_type:
            case "title":
                return "".join(t.get("plain_text", "") for t in prop.get("title", []))
            case "rich_text":
                return "".join(t.get("plain_text", "") for t in prop.get("rich_text", []))
            case "number":
                return prop.get("number")
            case "select":
                sel = prop.get("select")
                return sel.get("name", "") if sel else None
            case "multi_select":
                return [s.get("name", "") for s in prop.get("multi_select", [])]
            case "status":
                st = prop.get("status")
                return st.get("name", "") if st else None
            case "date":
                d = prop.get("date")
                return d.get("start", "") if d else None
            case "checkbox":
                return prop.get("checkbox", False)
            case "email":
                return prop.get("email", "")
            case "url":
                return prop.get("url", "")
            case "phone_number":
                return prop.get("phone_number", "")
            case "formula":
                formula = prop.get("formula", {})
                f_type = formula.get("type", "")
                return formula.get(f_type)
            case "rollup":
                rollup = prop.get("rollup", {})
                r_type = rollup.get("type", "")
                return rollup.get(r_type)
            case "people":
                return [
                    p.get("name", p.get("id", ""))
                    for p in prop.get("people", [])
                ]
            case "relation":
                return [r.get("id", "") for r in prop.get("relation", [])]
            case _:
                return None

    def _parse_page(self, page: dict, property_map: dict) -> dict:
        """Parse a Notion page into a flat dict using a property name mapping."""
        props = page.get("properties", {})
        result = {"_page_id": page.get("id", ""), "_url": page.get("url", "")}

        for key, notion_name in property_map.items():
            if notion_name in props:
                result[key] = self._extract_property(props[notion_name])
            else:
                result[key] = None

        return result

    def query_database(self, database_id: str, filter_obj: dict | None = None,
                       sorts: list | None = None) -> list[dict]:
        """Query a Notion database and return raw page objects."""
        if not database_id:
            return []

        params = {"database_id": database_id}
        if filter_obj:
            params["filter"] = filter_obj
        if sorts:
            params["sorts"] = sorts

        results = []
        has_more = True
        start_cursor = None

        while has_more:
            if start_cursor:
                params["start_cursor"] = start_cursor
            response = self.client.databases.query(**params)
            results.extend(response.get("results", []))
            has_more = response.get("has_more", False)
            start_cursor = response.get("next_cursor")

        return results

    def get_client_board(self) -> list[dict]:
        """Fetch all entries from the Client Board."""
        pages = self.query_database(self.db_ids.client_board_db_id)
        return [self._parse_page(p, self.config.client_board_properties) for p in pages]

    def get_active_clients(self) -> list[dict]:
        """Fetch all entries from the Active Clients table."""
        pages = self.query_database(self.db_ids.active_clients_db_id)
        return [self._parse_page(p, self.config.active_client_properties) for p in pages]

    def get_client_feedback(self, days_back: int = 7) -> list[dict]:
        """Fetch client feedback from the last N days."""
        filter_obj = None
        feedback_date_prop = self.config.feedback_properties.get("meeting_date", "Meeting Date")

        if days_back > 0:
            cutoff = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
            filter_obj = {
                "property": feedback_date_prop,
                "date": {"on_or_after": cutoff},
            }

        pages = self.query_database(
            self.db_ids.client_feedback_db_id,
            filter_obj=filter_obj,
            sorts=[{"property": feedback_date_prop, "direction": "descending"}],
        )
        return [self._parse_page(p, self.config.feedback_properties) for p in pages]

    def get_campaign_performance(self, client_name: str | None = None) -> list[dict]:
        """Fetch campaign performance data, optionally filtered by client."""
        filter_obj = None
        if client_name:
            client_prop = self.config.campaign_properties.get("client_name", "Client Name")
            filter_obj = {
                "property": client_prop,
                "rich_text": {"equals": client_name},
            }

        pages = self.query_database(
            self.db_ids.campaign_performance_db_id,
            filter_obj=filter_obj,
        )
        return [self._parse_page(p, self.config.campaign_properties) for p in pages]

    def get_database_schema(self, database_id: str) -> dict:
        """Retrieve the schema/properties of a database for discovery."""
        if not database_id:
            return {}
        db = self.client.databases.retrieve(database_id=database_id)
        schema = {}
        for name, prop in db.get("properties", {}).items():
            schema[name] = {
                "type": prop.get("type"),
                "id": prop.get("id"),
            }
        return schema

    def create_page(self, database_id: str, properties: dict,
                    children: list | None = None) -> dict:
        """Create a new page in a Notion database."""
        params = {
            "parent": {"database_id": database_id},
            "properties": properties,
        }
        if children:
            params["children"] = children
        return self.client.pages.create(**params)

    def append_blocks(self, page_id: str, children: list[dict]) -> None:
        """Append content blocks to an existing Notion page."""
        self.client.blocks.children.append(block_id=page_id, children=children)

    def update_page(self, page_id: str, properties: dict) -> dict:
        """Update properties on an existing Notion page."""
        return self.client.pages.update(page_id=page_id, properties=properties)
