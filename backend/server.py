"""
Truvala analysis backend.

Flow per request:
  1. Get listing data, EITHER by:
       (a) scraping a URL with our Selenium scrapers (zillow / realtor /
           redfin / trulia), OR
       (b) accepting a pre-structured Listing dict (from results.json), OR
       (c) accepting a legacy raw browser-DOM dump for backward compat.
  2. Normalize into a strict schema via gpt-4.1-mini.
  3. Deterministic buyer fit score (buyer_score module).
  4. AI report narrative (gpt-4.1-mini).
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field
from typing import Optional, Union

# Load OPENAI_API_KEY from ~/.env
load_dotenv(Path.home() / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent / "buyer_score_project"))
from buyer_score import calculate_buyer_fit_score

# ─── Scrapers ────────────────────────────────────────────────────────────────
# All four site scrapers + the shared Listing dataclass live in the scrapers/
# package we built. Importing them lazily would also be fine but explicit is
# clearer since this backend always needs them available.
sys.path.insert(0, str(Path(__file__).parent.parent / "truvala-agent-test"))
from scrapers import (
    BaseScraper,
    Listing,
    RealtorScraper,
    RedfinScraper,
    TruliaScraper,
    ZillowScraper,
)

# Host substring -> scraper class
SITE_MAP = {
    "zillow.com": ZillowScraper,
    "realtor.com": RealtorScraper,
    "redfin.com": RedfinScraper,
    "trulia.com": TruliaScraper,
}
SCRAPER_SOURCES = {"zillow", "realtor", "redfin", "trulia"}

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
MODEL = "gpt-4.1-mini"

# ─── Extraction ──────────────────────────────────────────────────────────────

EXTRACTION_SYSTEM = """You normalize a real-estate listing into a strict JSON schema.

The input is ONE of three shapes:
  (A) A structured Listing dict produced by our Selenium scrapers (Zillow /
      Realtor.com / Redfin / Trulia). Recognizable by the `source` field set
      to one of {"zillow","realtor","redfin","trulia"}. Other fields include
      url, address (joined "street, city, state zip"), price (string like
      "$450,000"), beds, baths, sqft, lot_size, year_built, property_type,
      description, schools[], and a `raw` bag with site-specific extras
      (hoaFee / hoa, priceHistory, daysOnZillow, tax_history, etc.).
  (B) A pre-normalized listing dict already in the target schema below
      (e.g. cached output from a previous run).
  (C) A legacy raw browser DOM dump with `url`, `page_title`, `visible_text`,
      `meta`. Messy text full of nav/ads — extract facts for the PRIMARY
      listing only.

Return strict JSON only. No markdown.

Rules:
- Split joined addresses into address / city / state / zip components.
- Convert prices and counts to numeric values (price = integer dollars).
- For scraper input (A), pull HOA from `raw.hoaFee` / `raw.hoa` /
  `raw.monthlyHoaFee`; price history from `raw.priceHistory`; days_on_market
  from `raw.daysOnZillow` or `raw.daysOnMarket`.
- If HOA explicitly says "No HOA Fee", set hoa_fee_monthly to 0.
- Keep land_lease_monthly separate from hoa_fee_monthly.
- Preserve manufactured/mobile-home-in-park property types exactly.
- floors: derive from description or property_type. One of
  "single_story", "two_story", "three_plus_story", or null.
- Use null for any missing value. Do not invent."""

LISTING_SCHEMA = {
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

# ─── Report generation ───────────────────────────────────────────────────────

REPORT_SYSTEM = """You are a homebuying analyst. Given a structured listing, buyer preferences,
and a deterministic fit score, produce a plain-English buyer report.

Return ONLY strict JSON — no markdown:
{
  "score": <buyer_fit_score integer>,
  "risk": "<Low | Medium | Medium-High | High>",
  "capex_estimate": "<e.g. '$5k–$15k near-term' or 'Low — move-in ready'>",
  "summary": "<2–3 sentence summary written directly to the buyer>",
  "warnings": ["<short specific warning>", ...],
  "positives": ["<short specific positive>", ...],
  "questions": ["<question to ask before touring>", ...]
}

Rules:
- 3–4 items per list, each under 12 words
- Risk reflects condition, land lease, financing complexity, and market signals
- Be specific to this listing — avoid generic boilerplate
- Do not invent facts not in the listing data"""


# ─── Request / response models ───────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    """Either `url` OR `listing` must be set.

    - `url`: a listing URL on zillow/realtor.com/redfin/trulia. We scrape it
      server-side via the matching scraper class.
    - `listing`: either a scraper Listing dict, a pre-normalized listing
      dict, or a legacy raw browser-DOM dump.
    """
    url: Optional[str] = None
    listing: Optional[dict] = None
    preferences: dict


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    # 1. Resolve to a raw input dict.
    if not req.url and not req.listing:
        raise HTTPException(
            status_code=400,
            detail="Must provide either `url` or `listing`.",
        )

    try:
        raw = await _resolve_input(req.url, req.listing)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Scraping failed: {e}")

    # 2. Normalize via GPT into the strict listing schema.
    try:
        structured = extract_listing(raw)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Extraction failed: {e}")

    # 3. Score deterministically.
    try:
        score_result = calculate_buyer_fit_score(structured, req.preferences)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Scoring failed: {e}")

    # 4. Generate the report narrative.
    try:
        return generate_report(structured, req.preferences, score_result)
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Report generation failed: {e}",
        )


@app.post("/scrape")
async def scrape_only(url: str):
    """Convenience endpoint: scrape a URL and return the raw Listing dict.
    Useful for debugging which fields the scraper is getting before paying
    for the GPT round trips."""
    try:
        listing = await asyncio.to_thread(_scrape_url_sync, url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Scraping failed: {e}")
    return listing


# ─── Helpers ─────────────────────────────────────────────────────────────────

async def _resolve_input(url, listing):
    """Return the raw dict that extract_listing() should normalize.

    - URL provided -> run the matching scraper.
    - listing dict provided -> pass through.
    """
    if url:
        return await asyncio.to_thread(_scrape_url_sync, url)
    # listing is a dict; might be a URL wrapped in {"url": ...}
    if isinstance(listing, dict):
        only_url = listing.get("url")
        looks_like_scrape_output = (listing.get("source") in SCRAPER_SOURCES)
        looks_like_normalized = "address" in listing and "city" in listing
        looks_like_raw_dump = (
            "visible_text" in listing
            or "page_title" in listing
            or "meta" in listing
        )
        if (only_url and not (looks_like_scrape_output
                              or looks_like_normalized
                              or looks_like_raw_dump)):
            return await asyncio.to_thread(_scrape_url_sync, only_url)
        return listing
    raise ValueError("`listing` must be a dict")


def _scrape_url_sync(url: str) -> dict:
    """Synchronously run the right scraper for `url` and return the first
    Listing dict. Raises ValueError for unsupported hosts."""
    if not url or not isinstance(url, str):
        raise ValueError("Empty URL")
    host = urlparse(url).netloc.lower()
    cls = next((c for k, c in SITE_MAP.items() if k in host), None)
    if cls is None:
        raise ValueError(
            "Unsupported host: " + host
            + " (supported: zillow.com, realtor.com, redfin.com, trulia.com)"
        )
    with cls() as scraper:  # type: BaseScraper
        listings = scraper.scrape(url)
    if not listings:
        raise ValueError("Scraper returned no listings for " + url)
    return listings[0].to_dict()


def extract_listing(raw: dict) -> dict:
    """Send `raw` (any of the three accepted input shapes) through GPT and
    return a dict matching LISTING_SCHEMA."""
    compact = _compact_for_extraction(raw)
    response = client.responses.create(
        model=MODEL,
        input=[
            {"role": "system", "content": EXTRACTION_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Normalize into this JSON shape:\n"
                    + json.dumps(LISTING_SCHEMA, indent=2)
                    + "\n\nInput:\n"
                    + json.dumps(compact, ensure_ascii=False)
                ),
            },
        ],
    )
    return parse_json(response.output_text)


def _compact_for_extraction(raw: dict) -> dict:
    """Trim huge fields (visible_text, photos) before sending to GPT."""
    if not isinstance(raw, dict):
        return raw

    # Scraper Listing dict -> drop heavy photo list, keep everything else.
    if raw.get("source") in SCRAPER_SOURCES:
        out = dict(raw)
        # Photos are URLs; the LLM doesn't need them for normalization.
        if "photos" in out and isinstance(out["photos"], list):
            out["photos_count"] = len(out["photos"])
            out["photos"] = out["photos"][:3]
        # Schools already normalized; LLM doesn't need them for the base
        # schema (they're passed through to the report separately).
        if isinstance(out.get("description"), str) and len(out["description"]) > 8000:
            out["description"] = out["description"][:8000]
        return out

    # Legacy raw browser DOM dump -> cap visible_text.
    if "visible_text" in raw or "page_title" in raw:
        return {
            "url": raw.get("url"),
            "page_title": raw.get("page_title"),
            "visible_text": (raw.get("visible_text") or "")[:12000],
            "meta": raw.get("meta", {}),
        }

    # Already-normalized or unknown: pass through.
    return raw


def generate_report(listing: dict, preferences: dict, score_result: dict) -> dict:
    payload = {
        "listing": listing,
        "preferences": preferences,
        "buyer_fit_score": score_result["buyer_fit_score"],
        "field_scores": score_result["field_scores"],
        "skipped_fields": score_result["skipped_fields"],
    }
    response = client.responses.create(
        model=MODEL,
        input=[
            {"role": "system", "content": REPORT_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
    )
    report = parse_json(response.output_text)

    report["field_scores"] = {
        key: {
            "label": key.replace("_", " ").title(),
            "utility": val["utility"],
            "explanation": val["explanation"],
        }
        for key, val in score_result.get("field_scores", {}).items()
    }
    return report


def parse_json(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        # Strip ```json ... ``` or ``` ... ``` fences.
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)