"""Normalize listings produced by the Selenium scrapers into a strict schema.

The original version of this script consumed a messy browser-extension dump.
This version is wired up to the project's `scrapers/` package, so the input
is already structured. GPT is used to do the *last mile*: split addresses,
convert price strings to numerics, surface HOA / land-lease fees from the
site-specific `raw` bag, derive MLS number + days-on-market, etc.

Input forms (auto-detected):
  1. A URL on a supported site (zillow / realtor.com / redfin / trulia) -
     we run the appropriate scraper and feed its output to GPT.
  2. A path to results.json produced by scrape.py (list of listings).
  3. A path to a single-listing JSON object (e.g. one element from
     results.json, or the legacy browser-extension format with
     `url`/`visible_text` keys - we pass it through unchanged).

Output:
  - When the input is a URL or a results.json with >1 listing, we write
    `structured_listings.json` (a list) to --out-dir (default ./).
  - When the input is a single listing, we write `structured_listing.json`
    next to the input file.

Usage:
  python extract_listing.py <URL_or_path> [--out-dir DIR] [--model MODEL]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, List
from urllib.parse import urlparse

from openai import OpenAI


EXTRACTION_MODEL_DEFAULT = "gpt-4.1-mini"


LISTING_EXTRACTION_PROMPT = """
You normalize a single real-estate listing into a strict JSON schema.

The input is already a structured record produced by a site scraper
(Zillow, Realtor.com, Redfin, or Trulia). Your job is *not* to re-extract
from raw HTML; your job is to:

  - Split the joined address string into address / city / state / zip.
  - Convert price strings like "$450,000" into a numeric price (integer).
  - Convert beds, baths, sqft, lot size, year_built into numbers when present.
  - Pull HOA fee, land-lease, MLS number, listing status, days-on-market,
    and price history from the `raw` bag when available; otherwise leave null.
  - Carry the `schools` list through unchanged (already normalized upstream).
  - If the listing is a manufactured/mobile home in a park, preserve that
    property type and add a warning if lot size describes the park, not
    owned land.

Return strict JSON only. No markdown, no commentary.

Rules:
  - Use null when a value is missing or unclear. Do not guess.
  - If HOA explicitly says "No HOA Fee", set hoa_fee_monthly to 0.
  - Keep land lease separate from HOA.
  - Include short source snippets so we can debug the extraction.
"""


SCHEMA_EXAMPLE = {
    "source": None,
    "source_url": None,
    "listing_id": None,
    "address": None,
    "city": None,
    "state": None,
    "zip": None,
    "latitude": None,
    "longitude": None,
    "price": None,
    "original_price": None,
    "beds": None,
    "baths": None,
    "sqft": None,
    "lot_size_text": None,
    "lot_size_sqft": None,
    "year_built": None,
    "property_type": None,
    "property_subtype": None,
    "hoa_fee_monthly": None,
    "land_lease_monthly": None,
    "listing_status": None,
    "days_on_market": None,
    "mls_number": None,
    "description": None,
    "photos": [],
    "schools": [
        {
            "name": None,
            "rating": None,
            "rating_scale": None,
            "distance_mi": None,
            "grades": None,
            "type": None,
            "level": None,
            "url": None,
        }
    ],
    "price_history": [
        {"date": None, "price": None, "event": None, "source": None}
    ],
    "warnings": [],
    "missing_fields": [],
    "source_snippets": {
        "price": None,
        "beds_baths_sqft": None,
        "property_type": None,
        "land_lease": None,
        "hoa": None,
        "year_built": None,
    },
    "extraction_confidence": None,
}


SUPPORTED_HOSTS = ("zillow.com", "realtor.com", "redfin.com", "trulia.com")


def is_url(s: str) -> bool:
    try:
        u = urlparse(s)
        return u.scheme in ("http", "https") and bool(u.netloc)
    except Exception:
        return False


def scrape_url_to_listings(url: str) -> List[dict]:
    """Run the matching site scraper and return its listings as dicts."""
    # Import lazily so users running on a results.json file don't need
    # selenium installed.
    from scrapers import (
        RealtorScraper,
        RedfinScraper,
        TruliaScraper,
        ZillowScraper,
    )

    host = urlparse(url).netloc.lower()
    if "zillow.com" in host:
        cls = ZillowScraper
    elif "realtor.com" in host:
        cls = RealtorScraper
    elif "redfin.com" in host:
        cls = RedfinScraper
    elif "trulia.com" in host:
        cls = TruliaScraper
    else:
        raise SystemExit(
            "Unsupported host. Supported: " + ", ".join(SUPPORTED_HOSTS)
        )

    with cls() as scraper:
        listings = scraper.scrape(url)
    return [l.to_dict() for l in listings]


def load_input(path: Path) -> List[dict]:
    """Load listings from a JSON file. Handles both:
      - A list (results.json from scrape.py)
      - A single dict (one listing, or legacy browser-extension format)
    """
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    raise SystemExit("Unsupported input JSON shape: " + str(type(data)))


def extract_listing(raw_listing: dict, client: OpenAI, model: str) -> dict:
    """Send one scraper Listing dict through GPT for normalization."""
    response = client.responses.create(
        model=model,
        input=[
            {"role": "system", "content": LISTING_EXTRACTION_PROMPT},
            {
                "role": "user",
                "content": (
                    "Normalize this listing into the JSON shape below.\n\n"
                    "Target schema:\n"
                    + json.dumps(SCHEMA_EXAMPLE, indent=2)
                    + "\n\nScraper output:\n"
                    + json.dumps(raw_listing, ensure_ascii=False)
                ),
            },
        ],
    )
    text = response.output_text.strip()
    # Strip accidental ```json fences if the model adds them anyway.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    return json.loads(text)


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description=(
            "Normalize scraper output into a strict listing schema "
            "via OpenAI."
        )
    )
    p.add_argument(
        "input",
        help=(
            "A listing URL (zillow / realtor / redfin / trulia) OR "
            "a path to a results.json file produced by scrape.py."
        ),
    )
    p.add_argument(
        "--out-dir",
        default=".",
        help="Directory to write structured output (default: cwd).",
    )
    p.add_argument(
        "--model",
        default=EXTRACTION_MODEL_DEFAULT,
        help="OpenAI model to use (default: %(default)s).",
    )
    p.add_argument(
        "-v", "--verbose", action="store_true",
        help="Print per-listing status to stderr.",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    if is_url(args.input):
        if args.verbose:
            print("Scraping " + args.input, file=sys.stderr)
        listings = scrape_url_to_listings(args.input)
        default_out = Path(args.out_dir) / "structured_listings.json"
    else:
        input_path = Path(args.input)
        if not input_path.exists():
            raise SystemExit("Input not found: " + str(input_path))
        listings = load_input(input_path)
        if len(listings) == 1:
            default_out = input_path.with_name("structured_listing.json")
        else:
            default_out = Path(args.out_dir) / "structured_listings.json"

    if not listings:
        raise SystemExit("No listings to process (scrape returned empty).")

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    structured: List[dict] = []
    for i, raw in enumerate(listings, 1):
        if args.verbose:
            print(
                "Normalizing listing %d/%d: %s"
                % (i, len(listings), raw.get("url") or raw.get("address")),
                file=sys.stderr,
            )
        try:
            structured.append(extract_listing(raw, client, args.model))
        except Exception as e:
            print(
                "WARN: failed to normalize listing %d (%s): %s"
                % (i, raw.get("url"), e),
                file=sys.stderr,
            )

    payload = structured[0] if len(structured) == 1 else structured
    default_out.parent.mkdir(parents=True, exist_ok=True)
    with default_out.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print("Wrote " + str(default_out))
    return 0
