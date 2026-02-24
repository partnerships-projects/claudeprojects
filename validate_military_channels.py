#!/usr/bin/env python3
"""
Military YouTube Channel Validator
===================================
Uses the Influencers Club API to validate whether YouTube creators
qualify as military-focused channels meeting activity and performance requirements.

Criteria (ALL must be met):
  1. Content niche is primarily military / defense / armed forces / war analysis /
     military history / military technology / weapons analysis
  2. Channel posted at least 3 videos within the last 30 days
  3. Combined views across videos posted in the last 30 days >= 250,000

Usage:
  python3 validate_military_channels.py                # Full validation run
  python3 validate_military_channels.py --discover     # Discover correct API endpoints first
  python3 validate_military_channels.py --debug        # Save raw API responses for inspection

Requires: requests (pip install requests)
"""

import json
import sys
import time
import os
import re
import argparse
from datetime import datetime, timedelta, timezone
from typing import Optional, Any

try:
    import requests
except ImportError:
    print("ERROR: 'requests' library not installed. Run: pip install requests")
    sys.exit(1)

# ──────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────

API_KEY = os.environ.get(
    "INFLUENCERS_CLUB_API_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoyMzc2Mzg2NzM5LCJpYXQiOjE3NzE1ODY3MzksImp0aSI6ImYyZDk0MDViMWFjYTRmZDBiODZkMzVjMWFkNzk5N2ZjIiwidXNlcl9pZCI6MjEyMzR9.8-RKK6etEFHfVFZq_Fo_7gGkKaEXwTlo24ZdVhtwTxc",
)

BASE_URL = "https://api-dashboard.influencers.club/public/v1"

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Accept": "application/json",
}

USERNAMES = [
    "military92",
    "aviationrepublic",
    "professorsimonshc",
    "offizieramira",
    "austenalexander",
    "marines",
    "mikeritland",
    "combatstory",
    "kindaconsensual",
    "truthtreasured",
]

# Military keywords for niche classification (lowercase)
MILITARY_KEYWORDS = [
    "military", "army", "navy", "marine", "air force", "defense", "defence",
    "armed forces", "veteran", "combat", "warfare", "war ", " war",
    "weapons", "weapon", "tactical", "special forces", "special operations",
    "infantry", "artillery", "tank", "fighter jet", "bomber", "missile",
    "drone", "uav", "geopolitics", "nato", "pentagon", "deployment",
    "battalion", "brigade", "soldier", "troops", "airborne", "paratrooper",
    "sniper", "rifle", "ammunition", "ordnance", "armor", "armour",
    "military history", "military technology", "mil-tech", "miltech",
    "battlefield", "frontline", "operations", "strategy",
    "defense analysis", "military analysis", "armed conflict",
    "national guard", "coast guard", "seal team", "ranger",
    "delta force", "sas", "officer", "enlisted", "recruit", "boot camp",
    "military life", "military training", "defense industry",
    "aircraft carrier", "submarine", "destroyer", "frigate", "corvette",
    "aviation", "military aviation", "warplane", "warship",
    "ukraine", "russia", "f-35", "f-16", "apache", "abrams",
    "leopard", "patriot", "himars", "javelin", "stinger",
]

# Keywords that signal NON-military content
REJECT_KEYWORDS = [
    "gaming", "gamer", "let's play", "gameplay", "fortnite",
    "call of duty multiplayer", "airsoft", "cosplay", "comedy", "prank",
    "vlog", "beauty", "makeup", "cooking", "recipe", "fitness", "workout",
    "music video", "unboxing", "crypto", "nft", "meme", "asmr",
]

THIRTY_DAYS_AGO = datetime.now(timezone.utc) - timedelta(days=30)
DEBUG_MODE = False


# ──────────────────────────────────────────────────────────────
# Logging / debug helpers
# ──────────────────────────────────────────────────────────────

def log(msg: str):
    print(msg)


def save_debug(username: str, label: str, data: Any):
    """In debug mode, save raw API responses to disk for inspection."""
    if not DEBUG_MODE:
        return
    debug_dir = "debug_responses"
    os.makedirs(debug_dir, exist_ok=True)
    path = os.path.join(debug_dir, f"{username}_{label}.json")
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, default=str)
    log(f"  [DEBUG] Saved raw response → {path}")


# ──────────────────────────────────────────────────────────────
# API helper with retry + exponential backoff
# ──────────────────────────────────────────────────────────────

def api_get(url: str, params: dict = None, retries: int = 4,
            silent_404: bool = False) -> Optional[Any]:
    """Make a GET request with exponential-backoff retries on transient errors."""
    delay = 2
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=30)
            if resp.status_code == 200:
                try:
                    return resp.json()
                except json.JSONDecodeError:
                    log(f"  [WARN] 200 but non-JSON body from {url}")
                    return {"_raw_text": resp.text}
            elif resp.status_code == 401:
                log(f"  [ERROR] 401 Unauthorized — check your API key")
                return None
            elif resp.status_code == 404:
                if not silent_404:
                    log(f"  [WARN] 404 Not Found: {url}")
                return None
            elif resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", delay))
                log(f"  [WARN] Rate limited (429). Waiting {retry_after}s...")
                time.sleep(retry_after)
                delay = retry_after * 2
                continue
            elif resp.status_code >= 500:
                log(f"  [WARN] Server error {resp.status_code}. Retrying in {delay}s...")
            else:
                log(f"  [WARN] HTTP {resp.status_code} for {url}. Body: {resp.text[:200]}")
                if attempt == 0:
                    return None  # don't retry on 4xx (except 429)
        except requests.exceptions.RequestException as e:
            log(f"  [WARN] Network error: {e}. Retrying in {delay}s...")

        time.sleep(delay)
        delay *= 2

    log(f"  [ERROR] All {retries} retries exhausted for {url}")
    return None


# ──────────────────────────────────────────────────────────────
# Endpoint discovery — run with --discover to find working paths
# ──────────────────────────────────────────────────────────────

def discover_endpoints():
    """
    Probe multiple endpoint URL patterns to find which ones return data.
    Run this once to determine the correct endpoint structure.
    """
    test_handle = "marines"  # well-known channel likely in the DB

    log("=" * 60)
    log("  ENDPOINT DISCOVERY MODE")
    log(f"  Testing with handle: {test_handle}")
    log("=" * 60)

    # ── Enrichment endpoint candidates ──
    enrich_patterns = [
        f"{BASE_URL}/enrich/full/youtube?handle={test_handle}",
        f"{BASE_URL}/enrich/raw/youtube?handle={test_handle}",
        f"{BASE_URL}/enrich/youtube?handle={test_handle}",
        f"{BASE_URL}/youtube/enrich/full?handle={test_handle}",
        f"{BASE_URL}/youtube/enrich?handle={test_handle}",
        f"{BASE_URL}/enrich?platform=youtube&handle={test_handle}",
        f"{BASE_URL}/profile/youtube?handle={test_handle}",
        f"{BASE_URL}/youtube/profile?handle={test_handle}",
        f"{BASE_URL}/creator/youtube?handle={test_handle}",
    ]

    log("\n── Trying enrichment endpoints ──")
    for url in enrich_patterns:
        resp = api_get(url, silent_404=True)
        status = "FOUND DATA" if resp else "no data"
        log(f"  [{status}] {url}")
        if resp:
            save_debug(test_handle, "enrich_discovery", resp)
            log(f"  Response keys: {list(resp.keys()) if isinstance(resp, dict) else type(resp)}")
            log(f"  Preview: {json.dumps(resp, indent=2, default=str)[:500]}")
            log("")

    # ── Post data endpoint candidates ──
    post_patterns = [
        f"{BASE_URL}/posts/youtube?handle={test_handle}",
        f"{BASE_URL}/post-data/youtube?handle={test_handle}",
        f"{BASE_URL}/youtube/posts?handle={test_handle}",
        f"{BASE_URL}/youtube/post-data?handle={test_handle}",
        f"{BASE_URL}/posts?platform=youtube&handle={test_handle}",
        f"{BASE_URL}/post?platform=youtube&handle={test_handle}",
        f"{BASE_URL}/content/youtube?handle={test_handle}",
        f"{BASE_URL}/videos/youtube?handle={test_handle}",
    ]

    log("\n── Trying post-data endpoints ──")
    for url in post_patterns:
        resp = api_get(url, silent_404=True)
        status = "FOUND DATA" if resp else "no data"
        log(f"  [{status}] {url}")
        if resp:
            save_debug(test_handle, "posts_discovery", resp)
            log(f"  Response keys: {list(resp.keys()) if isinstance(resp, dict) else type(resp)}")
            log(f"  Preview: {json.dumps(resp, indent=2, default=str)[:500]}")
            log("")

    # ── Credits endpoint candidates ──
    credit_patterns = [
        f"{BASE_URL}/credits",
        f"{BASE_URL}/account/credits",
        f"{BASE_URL}/account",
        f"{BASE_URL}/me",
        f"{BASE_URL}/usage",
    ]

    log("\n── Trying account/credits endpoints ──")
    for url in credit_patterns:
        resp = api_get(url, silent_404=True)
        status = "FOUND DATA" if resp else "no data"
        log(f"  [{status}] {url}")
        if resp:
            log(f"  {json.dumps(resp, indent=2, default=str)[:300]}")
            log("")

    log("\n" + "=" * 60)
    log("  Discovery complete. Update the script with working endpoints.")
    log("=" * 60)


# ──────────────────────────────────────────────────────────────
# Step 1 — Enrich profile
# ──────────────────────────────────────────────────────────────

def enrich_profile(username: str) -> Optional[dict]:
    """
    Call the Influencers Club 'Enrich by handle full' endpoint.
    Tries multiple URL patterns; returns the profile payload or None.
    """
    log(f"\n{'='*60}")
    log(f"  Enriching: @{username}")
    log(f"{'='*60}")

    # Try the most likely endpoint first, then fall back
    endpoints = [
        (f"{BASE_URL}/enrich/full/youtube", {"handle": username}),
        (f"{BASE_URL}/enrich/raw/youtube", {"handle": username}),
        (f"{BASE_URL}/enrich/youtube", {"handle": username}),
        (f"{BASE_URL}/enrich?platform=youtube", {"handle": username}),
    ]

    for url, params in endpoints:
        data = api_get(url, params=params, silent_404=True)
        if data:
            log(f"  Got data from: {url}")
            save_debug(username, "enrich", data)

            # Inspect the response shape
            if isinstance(data, dict):
                top_keys = list(data.keys())
                log(f"  Response top-level keys: {top_keys}")

                # Some APIs wrap data in a "data" or "result" key
                if "data" in data and isinstance(data["data"], dict):
                    data = data["data"]
                elif "result" in data and isinstance(data["result"], dict):
                    data = data["result"]
                elif "profile" in data and isinstance(data["profile"], dict):
                    data = data["profile"]

            return data

    log(f"  [ERROR] All enrichment endpoints failed for @{username}")
    return None


# ──────────────────────────────────────────────────────────────
# Step 1b — Get post data
# ──────────────────────────────────────────────────────────────

def get_post_data(username: str) -> Optional[dict]:
    """
    Call the 'Get Post Data with Engagement Metrics' endpoint.
    Tries multiple URL patterns.
    """
    endpoints = [
        (f"{BASE_URL}/posts/youtube", {"handle": username}),
        (f"{BASE_URL}/post-data/youtube", {"handle": username}),
        (f"{BASE_URL}/youtube/posts", {"handle": username}),
        (f"{BASE_URL}/posts", {"platform": "youtube", "handle": username}),
        (f"{BASE_URL}/content/youtube", {"handle": username}),
        (f"{BASE_URL}/videos/youtube", {"handle": username}),
    ]

    for url, params in endpoints:
        data = api_get(url, params=params, silent_404=True)
        if data:
            log(f"  Post data retrieved via: {url}")
            save_debug(username, "posts", data)
            return data

    log(f"  [INFO] No separate post-data endpoint found — using enrichment data only")
    return None


# ──────────────────────────────────────────────────────────────
# Deep field extraction helpers
# ──────────────────────────────────────────────────────────────

def deep_get(obj: Any, *keys: str) -> Any:
    """Traverse nested dicts/lists to find a value by trying multiple key names."""
    for key in keys:
        if isinstance(obj, dict):
            # Direct key lookup
            if key in obj:
                return obj[key]
            # Case-insensitive lookup
            for k, v in obj.items():
                if k.lower() == key.lower():
                    return v
    return None


def find_nested_lists(obj: Any, depth: int = 3) -> list[list]:
    """Find all list values within a nested dict (up to given depth)."""
    results = []
    if depth <= 0:
        return results
    if isinstance(obj, dict):
        for v in obj.values():
            if isinstance(v, list) and len(v) > 0:
                results.append(v)
            elif isinstance(v, dict):
                results.extend(find_nested_lists(v, depth - 1))
    return results


def extract_text_fields(obj: Any, depth: int = 3) -> list[str]:
    """Recursively extract all string values from a nested structure."""
    texts = []
    if depth <= 0:
        return texts
    if isinstance(obj, str):
        texts.append(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            # Skip URL-only fields, IDs, etc.
            if k.lower() in ("id", "profile_picture", "avatar", "thumbnail",
                              "url", "link", "channel_url"):
                continue
            texts.extend(extract_text_fields(v, depth - 1))
    elif isinstance(obj, list):
        for item in obj:
            texts.extend(extract_text_fields(item, depth - 1))
    return texts


# ──────────────────────────────────────────────────────────────
# Step 2 — Content niche classification
# ──────────────────────────────────────────────────────────────

def classify_niche(profile: dict) -> tuple[bool, str]:
    """
    Analyze the full profile data to determine if the channel
    is primarily military-focused.

    Returns (is_military: bool, reasoning: str).
    """
    # Build text corpus from all relevant profile data
    text_parts = []

    # Channel-level description/bio fields
    for key in ["bio", "description", "channel_description", "about",
                 "display_name", "channel_name", "name", "title",
                 "channel_display_name", "summary"]:
        val = deep_get(profile, key)
        if isinstance(val, str) and val.strip():
            text_parts.append(val)

    # Topics / categories / hashtags / tags
    for key in ["topics", "categories", "tags", "hashtags", "video_topics",
                 "video_categories", "niche", "category", "genre",
                 "channel_keywords", "keywords"]:
        val = deep_get(profile, key)
        if isinstance(val, list):
            text_parts.extend([str(v) for v in val])
        elif isinstance(val, str) and val.strip():
            text_parts.append(val)

    # Extract video titles
    video_titles = extract_video_titles(profile)
    text_parts.extend(video_titles)

    # If still sparse, do a deep text extraction
    if len(text_parts) < 3:
        deep_texts = extract_text_fields(profile, depth=2)
        text_parts.extend(deep_texts[:50])  # cap to avoid noise

    combined_text = " ".join(text_parts).lower()

    if not combined_text.strip():
        return False, "No description or video data available to classify"

    # Count military keyword hits (unique keywords matched)
    mil_matched = [kw for kw in MILITARY_KEYWORDS if kw.lower() in combined_text]
    mil_hits = len(mil_matched)

    # Count reject keyword hits
    reject_matched = [kw for kw in REJECT_KEYWORDS if kw.lower() in combined_text]
    reject_hits = len(reject_matched)

    # Military ratio among video titles
    mil_video_count = 0
    for title in video_titles:
        title_lower = title.lower()
        if any(kw in title_lower for kw in MILITARY_KEYWORDS):
            mil_video_count += 1

    total_videos = len(video_titles) if video_titles else 0
    mil_video_ratio = mil_video_count / total_videos if total_videos > 0 else 0

    # ── Classification logic ──
    # Strong military: many keyword matches + majority military video titles
    if mil_hits >= 5 and reject_hits <= 1 and (mil_video_ratio >= 0.5 or total_videos == 0):
        reason = (f"Strong military focus: {mil_hits} military keyword matches "
                  f"({', '.join(mil_matched[:8])}), "
                  f"{mil_video_count}/{total_videos} military-themed videos, "
                  f"{reject_hits} reject signals")
        return True, reason

    # Moderate military: decent keywords + clean reject + good video ratio
    if mil_hits >= 3 and reject_hits == 0 and (mil_video_ratio >= 0.5 or total_videos == 0):
        reason = (f"Military focus confirmed: {mil_hits} keyword matches "
                  f"({', '.join(mil_matched[:6])}), "
                  f"{mil_video_count}/{total_videos} military-themed videos, "
                  f"zero reject signals")
        return True, reason

    # Video-title-driven: most videos are military even if bio is sparse
    if total_videos >= 3 and mil_video_ratio >= 0.7:
        reason = (f"Majority military video content: {mil_video_count}/{total_videos} "
                  f"military-themed videos with {mil_hits} keyword matches")
        return True, reason

    # Keyword-heavy with no video data
    if mil_hits >= 8 and reject_hits <= 2 and total_videos == 0:
        reason = (f"Heavy military keyword presence: {mil_hits} matches "
                  f"({', '.join(mil_matched[:8])}), "
                  f"no video titles available for cross-check")
        return True, reason

    # ── Not qualified ──
    reason = (f"Not primarily military: {mil_hits} military keywords "
              f"({', '.join(mil_matched[:5]) if mil_matched else 'none'}), "
              f"{reject_hits} reject keywords "
              f"({', '.join(reject_matched[:3]) if reject_matched else 'none'}), "
              f"{mil_video_count}/{total_videos} military-themed videos")
    return False, reason


def extract_video_titles(profile: dict) -> list[str]:
    """Extract video titles from the enrichment data, handling various response shapes."""
    titles = []

    # Try direct list keys
    for key in ["recent_videos", "videos", "posts", "recent_posts",
                 "latest_videos", "latest_posts", "post_data", "content"]:
        items = deep_get(profile, key)
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    for tkey in ["title", "name", "text", "description",
                                  "caption", "video_title"]:
                        t = deep_get(item, tkey)
                        if isinstance(t, str) and t.strip() and len(t) > 5:
                            titles.append(t.strip())
                            break
                elif isinstance(item, str) and len(item) > 5:
                    titles.append(item.strip())

    # If nothing found, search nested lists
    if not titles:
        nested = find_nested_lists(profile)
        for lst in nested:
            if len(lst) > 0 and isinstance(lst[0], dict):
                for item in lst:
                    for tkey in ["title", "name", "text"]:
                        t = item.get(tkey, "")
                        if isinstance(t, str) and len(t) > 5:
                            titles.append(t.strip())
                            break

    return titles


# ──────────────────────────────────────────────────────────────
# Steps 3 & 4 — Posting frequency + view aggregation
# ──────────────────────────────────────────────────────────────

def parse_date(date_val: Any) -> Optional[datetime]:
    """Parse a date value from various formats (string, int timestamp, etc.)."""
    if date_val is None:
        return None

    # Handle Unix timestamps (seconds or milliseconds)
    if isinstance(date_val, (int, float)):
        try:
            if date_val > 1e12:  # milliseconds
                return datetime.fromtimestamp(date_val / 1000, tz=timezone.utc)
            else:
                return datetime.fromtimestamp(date_val, tz=timezone.utc)
        except (OSError, ValueError):
            return None

    date_str = str(date_val).strip()
    if not date_str:
        return None

    formats = [
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%b %d, %Y",
        "%d %b %Y",
        "%m/%d/%Y",
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue

    # Final fallback: fromisoformat
    try:
        return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        pass

    return None


def extract_videos_with_dates(profile: dict, post_data: Optional[dict] = None) -> list[dict]:
    """
    Extract video items with date, views, and title from all available data.
    Returns a list of dicts: [{title, views, date_obj, date_str}, ...]
    """
    raw_items = []

    # Gather video-like objects from all sources
    sources = [profile]
    if post_data:
        sources.append(post_data)

    for source in sources:
        # Try direct keys
        for key in ["recent_videos", "videos", "posts", "recent_posts",
                     "latest_videos", "latest_posts", "post_data", "data",
                     "results", "content", "items"]:
            items = deep_get(source, key)
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict):
                        raw_items.append(item)

        # Also check nested structures
        if not raw_items:
            nested = find_nested_lists(source)
            for lst in nested:
                if lst and isinstance(lst[0], dict):
                    # Check if these look like video objects (have date-like or view-like fields)
                    sample = lst[0]
                    has_date = any(k for k in sample.keys()
                                  if "date" in k.lower() or "time" in k.lower()
                                  or "publish" in k.lower() or "created" in k.lower())
                    has_views = any(k for k in sample.keys()
                                   if "view" in k.lower() or "play" in k.lower()
                                   or "watch" in k.lower())
                    if has_date or has_views:
                        raw_items.extend(lst)

    # Parse each item into a normalized video record
    parsed = []
    seen_titles = set()

    for item in raw_items:
        # Extract date
        date_obj = None
        for dkey in ["date", "published_at", "publishedAt", "upload_date",
                      "created_at", "posted_at", "post_date", "timestamp",
                      "publish_date", "uploaded_at"]:
            dval = deep_get(item, dkey)
            if dval is not None:
                date_obj = parse_date(dval)
                if date_obj:
                    break

        # Extract views
        views = 0
        for vkey in ["views", "view_count", "viewCount", "total_views",
                      "plays", "play_count", "watch_count"]:
            raw = deep_get(item, vkey)
            if raw is not None:
                try:
                    views = int(float(str(raw).replace(",", "")))
                except (ValueError, TypeError):
                    pass
                break

        # Extract title
        title = ""
        for tkey in ["title", "name", "text", "caption", "video_title"]:
            t = deep_get(item, tkey)
            if isinstance(t, str) and t.strip() and len(t) > 3:
                title = t.strip()
                break

        # Deduplicate by title
        dedup_key = title.lower() if title else f"__no_title_{len(parsed)}"
        if dedup_key in seen_titles:
            continue
        seen_titles.add(dedup_key)

        parsed.append({
            "title": title,
            "views": views,
            "date_obj": date_obj,
            "date_str": date_obj.strftime("%Y-%m-%d") if date_obj else "unknown",
        })

    return parsed


def analyze_recent_activity(profile: dict, post_data: Optional[dict] = None) -> dict:
    """
    Count videos in last 30 days and sum their views.
    Returns dict with videos_last_30_days, total_views_last_30_days, example_videos.
    """
    all_videos = extract_videos_with_dates(profile, post_data)

    # Filter to last 30 days
    recent = [v for v in all_videos if v["date_obj"] and v["date_obj"] >= THIRTY_DAYS_AGO]

    # Sort by date descending
    recent.sort(key=lambda x: x["date_obj"] or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True)

    total_views = sum(v["views"] for v in recent)

    # Format example videos for output (strip internal date_obj)
    examples = []
    for v in recent[:5]:
        examples.append({
            "title": v["title"],
            "views": v["views"],
            "date": v["date_str"],
        })

    return {
        "videos_last_30_days": len(recent),
        "total_views_last_30_days": total_views,
        "example_recent_videos": examples,
        "all_videos_found": len(all_videos),
    }


# ──────────────────────────────────────────────────────────────
# Step 5 — Final qualification + confidence
# ──────────────────────────────────────────────────────────────

def compute_confidence(is_military: bool, videos_count: int,
                       total_views: int) -> str:
    """Confidence score based on how strongly criteria are exceeded."""
    if not is_military:
        return "Low"
    if videos_count >= 8 and total_views >= 1_000_000:
        return "High"
    if videos_count >= 5 and total_views >= 500_000:
        return "High"
    if videos_count >= 3 and total_views >= 250_000:
        return "Medium"
    return "Low"


def extract_channel_info(profile: dict, username: str) -> dict:
    """Extract display name and channel URL from profile data."""
    channel_name = ""
    for key in ["display_name", "channel_name", "name", "title",
                 "channel_display_name", "full_name"]:
        val = deep_get(profile, key)
        if isinstance(val, str) and val.strip():
            channel_name = val.strip()
            break
    if not channel_name:
        channel_name = f"@{username}"

    channel_url = ""
    for key in ["channel_url", "url", "channel_link", "profile_url", "link"]:
        val = deep_get(profile, key)
        if isinstance(val, str) and val.strip():
            channel_url = val.strip()
            break
    if not channel_url:
        channel_url = f"https://www.youtube.com/@{username}"

    return {"channel_name": channel_name, "channel_url": channel_url}


# ──────────────────────────────────────────────────────────────
# Main validation pipeline
# ──────────────────────────────────────────────────────────────

def validate_channels(usernames: list[str]) -> dict:
    """Run the full 5-step validation pipeline on all usernames."""
    qualified = []
    not_qualified = []

    for i, username in enumerate(usernames, 1):
        log(f"\n[{i}/{len(usernames)}] Processing @{username}...")

        # ── Step 1: Enrich ──
        profile = enrich_profile(username)
        if profile is None:
            not_qualified.append({
                "channel_name": f"@{username}",
                "username": username,
                "reason_for_rejection":
                    "API enrichment failed — could not retrieve profile data",
            })
            continue

        # Also try post-data endpoint
        post_data = get_post_data(username)

        info = extract_channel_info(profile, username)

        # ── Step 2: Niche classification ──
        is_military, mil_reasoning = classify_niche(profile)
        if not is_military:
            not_qualified.append({
                "channel_name": info["channel_name"],
                "username": username,
                "reason_for_rejection": f"Niche check failed — {mil_reasoning}",
            })
            log(f"  REJECTED (niche): {mil_reasoning}")
            continue

        log(f"  Niche: MILITARY — {mil_reasoning}")

        # ── Steps 3 & 4: Frequency + views ──
        activity = analyze_recent_activity(profile, post_data)
        log(f"  Activity: {activity['videos_last_30_days']} videos in 30 days, "
            f"{activity['total_views_last_30_days']:,} views "
            f"(total videos found: {activity['all_videos_found']})")

        if activity["videos_last_30_days"] < 3:
            not_qualified.append({
                "channel_name": info["channel_name"],
                "username": username,
                "reason_for_rejection": (
                    f"Posting frequency too low — "
                    f"{activity['videos_last_30_days']} video(s) in last 30 days "
                    f"(minimum 3 required)"
                ),
            })
            log(f"  REJECTED (frequency)")
            continue

        if activity["total_views_last_30_days"] < 250_000:
            not_qualified.append({
                "channel_name": info["channel_name"],
                "username": username,
                "reason_for_rejection": (
                    f"Insufficient views — "
                    f"{activity['total_views_last_30_days']:,} total views "
                    f"in last 30 days (minimum 250,000 required)"
                ),
            })
            log(f"  REJECTED (views)")
            continue

        # ── Step 5: Qualified! ──
        confidence = compute_confidence(
            is_military,
            activity["videos_last_30_days"],
            activity["total_views_last_30_days"],
        )

        qualified.append({
            "channel_name": info["channel_name"],
            "username": username,
            "platform": "YouTube",
            "channel_url": info["channel_url"],
            "niche_confirmation": mil_reasoning,
            "videos_last_30_days": activity["videos_last_30_days"],
            "total_views_last_30_days": activity["total_views_last_30_days"],
            "example_recent_videos": activity["example_recent_videos"],
            "confidence_score": confidence,
        })
        log(f"  QUALIFIED — {activity['videos_last_30_days']} videos, "
            f"{activity['total_views_last_30_days']:,} views, confidence={confidence}")

    return {
        "qualified_channels": qualified,
        "not_qualified_channels": not_qualified,
    }


# ──────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────

def main():
    global DEBUG_MODE

    parser = argparse.ArgumentParser(description="Military YouTube Channel Validator")
    parser.add_argument("--discover", action="store_true",
                        help="Run endpoint discovery mode to find correct API paths")
    parser.add_argument("--debug", action="store_true",
                        help="Save raw API responses to debug_responses/ directory")
    parser.add_argument("--output", "-o", default="military_channel_validation_results.json",
                        help="Output JSON file path (default: military_channel_validation_results.json)")
    args = parser.parse_args()

    DEBUG_MODE = args.debug

    if args.discover:
        discover_endpoints()
        return

    log("=" * 60)
    log("  Military YouTube Channel Validator")
    log("  Powered by Influencers Club API")
    log(f"  Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    log(f"  Evaluating {len(USERNAMES)} channels")
    log("=" * 60)

    # Optionally check credits
    log("\n[Checking API credits...]")
    for cred_url in [f"{BASE_URL}/credits", f"{BASE_URL}/account/credits",
                      f"{BASE_URL}/account"]:
        credits_data = api_get(cred_url, silent_404=True)
        if credits_data:
            log(f"  Credits: {json.dumps(credits_data, indent=2, default=str)[:300]}")
            break
    else:
        log("  Could not retrieve credit info (non-critical, continuing...)")

    # Run the validation pipeline
    results = validate_channels(USERNAMES)

    # ── Summary ──
    log("\n" + "=" * 60)
    log("  RESULTS SUMMARY")
    log("=" * 60)
    log(f"  Qualified:     {len(results['qualified_channels'])}")
    log(f"  Not Qualified: {len(results['not_qualified_channels'])}")

    for ch in results["qualified_channels"]:
        log(f"    + @{ch['username']} ({ch['channel_name']}) — "
            f"{ch['videos_last_30_days']} videos, "
            f"{ch['total_views_last_30_days']:,} views [{ch['confidence_score']}]")

    for ch in results["not_qualified_channels"]:
        log(f"    - @{ch['username']} — {ch['reason_for_rejection']}")

    # Write output
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    log(f"\n  Full results written to: {args.output}")

    # Also print JSON
    log("\n" + "=" * 60)
    log("  FULL JSON OUTPUT")
    log("=" * 60)
    print(json.dumps(results, indent=2, ensure_ascii=False))

    return results


if __name__ == "__main__":
    main()
