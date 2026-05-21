"""
Truvala analysis backend.

Flow per request:
  1. Extract structured listing from raw browser DOM scrape  (gpt-4.1-mini)
  2. Deterministic buyer fit score                           (buyer_score module)
  3. Deterministic risk analysis                             (risk modules)
  4. AI report narrative — grounded in #2 and #3            (gpt-4.1-mini)
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

load_dotenv(Path.home() / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent / "buyer_score_project"))
from buyer_score import calculate_buyer_fit_score
from cost_calculator import calculate_monthly_costs
from partners.ecosolar import get_ecosolar_estimate
from risk import analyze_risk

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

EXTRACTION_SYSTEM = """You extract structured real estate listing facts from browser DOM text.

The input is messy: it includes navigation, similar homes, ads, duplicate values, and unrelated content.
Extract facts for the PRIMARY listing only. Return strict JSON only. No markdown.

Rules:
- Use null for any missing value
- Convert prices and counts to numeric values
- If HOA says "No HOA Fee", set hoa_fee_monthly to 0
- Keep land_lease_monthly separate from hoa_fee_monthly
- Preserve manufactured/mobile-home-in-park property types exactly
- floors: extract as "single_story", "two_story", "three_plus_story", or null
- description: include the full listing description and agent remarks
- schools: array of all schools listed, each as {"name": "...", "type": "elementary|middle|high|district", "rating": <int or null>}
  Extract rating from patterns like "9/10" near a school name — use the number before the slash. Include all schools found, not just one."""

LISTING_SCHEMA = {
    "address": None, "city": None, "state": None, "zip": None,
    "price": None, "beds": None, "baths": None, "sqft": None,
    "year_built": None, "property_type": None, "property_subtype": None,
    "hoa_fee_monthly": None, "land_lease_monthly": None,
    "listing_status": None, "days_on_market": None,
    "description": None, "floors": None,
    "schools": [],
}

# ─── Report generation ────────────────────────────────────────────────────────

REPORT_SYSTEM = """You are a homebuying analyst writing a buyer report from structured analysis data.

You are given:
- A structured listing
- The buyer's preferences
- A deterministic buyer fit score with per-field explanations
- A structured risk report produced by rule-based analysis modules (not your opinion)

Your job is to write the narrative fields only. The risk analysis has already been done.

Return ONLY strict JSON — no markdown:
{
  "score": <copy buyer_fit_score exactly — do not change it>,
  "risk": "<Low | Medium | Medium-High | High>",
  "capex_estimate": "<derive from component_lifespan signals and checklist cost estimates>",
  "summary": "<3–4 sentences written directly to the buyer synthesizing all three sources: (1) one sentence on how well the listing fits their preferences, referencing the buyer_fit_score and the strongest field_score result; (2) one sentence on the top risk signal from the risk_report computed_risk_signals; (3) one sentence on a key listing fact (price, size, location, or condition)>",
  "warnings": ["<derived from High-severity computed_risk_signals in the risk_report>", ...],
  "positives": ["<what genuinely works for this buyer based on field_scores and listing facts>", ...],
  "questions": ["<the most important buyer_questions from the risk_report verification checklist>", ...]
}

Rules:
- 3–4 items per list, each warning/positive/question under 14 words
- Summary must draw from all three sources: buyer fit score, risk report, and listing facts — do not write a summary that could apply to any listing
- Risk level must reflect the severity of computed_risk_signals, not your general impression
- Warnings must be traceable to a specific computed_risk_signal in the risk_report — do not invent
- Questions should prioritize High-priority items from the verification checklist
- Do not mention or invent risks not present in the risk_report
- Positives should reference specific field_score wins, not generic praise"""


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

    # Risk analysis runs before the model call so findings ground the narrative
    try:
        risk_report = analyze_risk(structured)
    except Exception as e:
        risk_report = {"error": str(e)}

    try:
        report = generate_report(structured, req.preferences, score_result, risk_report)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    report["risk_report"] = risk_report
    report["listing"]     = structured  # passed to /chat for full context

    # Monthly cost breakdown + EcoSolar (non-fatal if they fail)
    report["monthly_costs"] = calculate_monthly_costs(structured)
    if report["monthly_costs"]:
        zip_code = str(structured.get("zip") or "")
        sqft     = structured.get("sqft")
        utility  = report["monthly_costs"]["utilities"]
        report["ecosolar"] = get_ecosolar_estimate(zip_code, sqft, utility)
    else:
        report["ecosolar"] = None

    return report


CHAT_SYSTEM = """\
You are Truvala, a friendly AI homebuying assistant embedded in a listing analysis tool. \
You have already completed a full risk and buyer-fit analysis on a specific listing. \
The buyer is now asking you follow-up questions in a chat.

Listing facts:
{listing_json}

Buyer fit score: {score}/100
Capex estimate: {capex}
Buyer preferences: {prefs_json}

Risk analysis findings:
{risk_json}

Guidelines:
- Be conversational, warm, and direct — you are on the buyer's side
- Ground every answer in the listing and risk data above — never invent facts
- Keep responses concise: 2–4 sentences for most questions
- If something is not in the data, say so clearly rather than speculating
- When useful, point to specific questions the buyer should ask the seller or inspector\
"""

CHAT_INIT_PROMPT = """\
This is the opening of the chat. The buyer just opened the full risk report.

Write a brief, friendly opening message (1–2 sentences) that references a specific key risk \
you found in THIS listing — not a generic welcome.
Then provide exactly 3 suggested follow-up questions that are specific to this listing's \
actual risk profile. Make them concrete and actionable, not generic.

Return strict JSON only, no markdown:
{"message": "...", "suggested_questions": ["...", "...", "..."]}\
"""


COMPARE_CHAT_SYSTEM = """\
You are Truvala, a friendly AI homebuying assistant. The buyer has {n} listings pinned side by side.

Buyer preferences: {prefs_json}

{listings_block}

Guidelines:
- Be conversational, warm, and direct — you are on the buyer's side
- Ground every answer in the listing data above — never invent facts
- Keep responses concise: 2–4 sentences for most questions
- When comparing, refer to listings by their address (shortened is fine) and be direct about tradeoffs\
"""

COMPARE_INIT_PROMPT = """\
The buyer is comparing {n} listings side by side. Write a brief opening message (2 sentences max) \
that calls out the single most important tradeoff or contrast across these specific listings — \
the insight that would most influence a real buying decision. Be concrete, not generic.

Then provide exactly 3 suggested follow-up questions specific to these listings.

Return strict JSON only, no markdown:
{{"message": "...", "suggested_questions": ["...", "...", "..."]}}\
"""


def _format_compare_listing(i: int, l: dict) -> str:
    rr = l.get("risk_report", {})
    signals = []
    for module in ["age_era", "component_lifespan", "listing_language"]:
        signals.extend(rr.get(module, {}).get("computed_risk_signals", [])[:2])
    facts = json.dumps(l.get("listing", {}), ensure_ascii=False)[:400]
    return (
        f"Listing {i + 1} — {l.get('address', 'Unknown')}\n"
        f"  Score: {l.get('score', 0)}/100 | Risk: {l.get('risk', '?')} | "
        f"Capex: {l.get('capex_estimate', '?')}\n"
        f"  Facts: {facts}\n"
        f"  Top risk signals: {json.dumps(signals[:4], ensure_ascii=False)}"
    )


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    risk_report: dict
    listing: dict
    preferences: dict
    score: int = 0
    capex_estimate: str = ""
    compare_listings: list[dict] = []


@app.post("/chat")
async def chat(req: ChatRequest):
    is_compare = len(req.compare_listings) > 0
    is_init    = len(req.messages) == 0

    if is_compare:
        n = len(req.compare_listings)
        listings_block = "\n\n".join(
            _format_compare_listing(i, l) for i, l in enumerate(req.compare_listings)
        )
        system = COMPARE_CHAT_SYSTEM.format(
            n=n,
            prefs_json=json.dumps(req.preferences, ensure_ascii=False),
            listings_block=listings_block,
        )
        init_prompt = COMPARE_INIT_PROMPT.format(n=n)
    else:
        system = CHAT_SYSTEM.format(
            listing_json=json.dumps(req.listing, ensure_ascii=False),
            score=req.score,
            capex=req.capex_estimate,
            prefs_json=json.dumps(req.preferences, ensure_ascii=False),
            risk_json=json.dumps(req.risk_report, ensure_ascii=False),
        )
        init_prompt = CHAT_INIT_PROMPT

    input_messages = [{"role": "system", "content": system}]
    if is_init:
        input_messages.append({"role": "user", "content": init_prompt})
    else:
        input_messages.extend(
            [{"role": m.role, "content": m.content} for m in req.messages]
        )

    response = client.responses.create(model=MODEL, input=input_messages)

    if is_init:
        return parse_json(response.output_text)
    return {"message": response.output_text.strip()}


def extract_listing(raw_scrape: dict) -> dict:
    compact = {
        "url": raw_scrape.get("url"),
        "page_title": raw_scrape.get("page_title"),
        "visible_text": (raw_scrape.get("visible_text") or "")[:25000],
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


def generate_report(
    listing: dict, preferences: dict, score_result: dict, risk_report: dict
) -> dict:
    payload = {
        "listing": listing,
        "preferences": preferences,
        "buyer_fit_score": score_result["buyer_fit_score"],
        "field_scores": score_result["field_scores"],
        "skipped_fields": score_result["skipped_fields"],
        "risk_report": risk_report,
    }
    response = client.responses.create(
        model=MODEL,
        input=[
            {"role": "system", "content": REPORT_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
    )
    report = parse_json(response.output_text)

    # Always use the deterministic score — never the model's
    report["score"] = score_result["buyer_fit_score"]

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
