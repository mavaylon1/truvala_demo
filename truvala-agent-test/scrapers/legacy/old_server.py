"""
Truvala analysis backend.

Flow per request:
  1. Extract structured listing from raw browser DOM scrape  (gpt-4.1-mini)
  2. Deterministic buyer fit score                           (buyer_score module)
  3. AI report narrative                                     (gpt-4.1-mini)
"""

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

# Load OPENAI_API_KEY from ~/.env (same as rentcast_test.py)
load_dotenv(Path.home() / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent / "buyer_score_project"))
from buyer_score import calculate_buyer_fit_score

sys.path.insert(0, str(Path(__file__).parent.parent / "truvala-agent-test"))
from extract_listing import * 

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

MODEL = "gpt-4.1-mini"

# ─── Extraction ───────────────────────────────────────────────────────────────
# Adapted from truvala-agent-test/extract_listing.py

EXTRACTION_SYSTEM = """You extract structured real estate listing facts from browser DOM text.

The input is messy: it includes navigation, similar homes, ads, duplicate values, and unrelated content.
Extract facts for the PRIMARY listing only. Return strict JSON only. No markdown.

Rules:
- Use null for any missing value
- Convert prices and counts to numeric values
- If HOA says "No HOA Fee", set hoa_fee_monthly to 0
- Keep land_lease_monthly separate from hoa_fee_monthly
- Preserve manufactured/mobile-home-in-park property types exactly
- floors: extract as "single_story", "two_story", "three_plus_story", or null"""

LISTING_SCHEMA = {
    "address": None, "city": None, "state": None, "zip": None,
    "price": None, "beds": None, "baths": None, "sqft": None,
    "year_built": None, "property_type": None, "property_subtype": None,
    "hoa_fee_monthly": None, "land_lease_monthly": None,
    "listing_status": None, "days_on_market": None,
    "description": None, "floors": None,
}

# ─── Report generation ────────────────────────────────────────────────────────

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


class AnalyzeRequest(BaseModel):
    listing: dict
    preferences: dict


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    try:
        structured = extract_listing(req.listing)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Extraction failed: {e}")

    try:
        score_result = calculate_buyer_fit_score(structured, req.preferences)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Scoring failed: {e}")

    try:
        return generate_report(structured, req.preferences, score_result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")


def extract_listing(raw_scrape: dict) -> dict:
    compact = {
        "url": raw_scrape.get("url"),
        "page_title": raw_scrape.get("page_title"),
        "visible_text": (raw_scrape.get("visible_text") or "")[:12000],
        "meta": raw_scrape.get("meta", {}),
    }
    response = client.responses.create(
        model=MODEL,
        input=[
            {"role": "system", "content": EXTRACTION_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"Extract the primary listing into this JSON shape:\n"
                    f"{json.dumps(LISTING_SCHEMA, indent=2)}\n\n"
                    f"Input:\n{json.dumps(compact, ensure_ascii=False)}"
                ),
            },
        ],
    )
    return parse_json(response.output_text)


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
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)
