import json
import os
import sys
from pathlib import Path

from openai import OpenAI


EXTRACTION_MODEL = "gpt-4.1-mini"


LISTING_EXTRACTION_PROMPT = """
You extract structured real estate listing facts from messy browser-extension scrape data.

The input may include navigation text, similar homes, school information, legal text,
ads, duplicate values, forms, and unrelated nearby listings.

Extract facts only for the primary listing page, not similar homes or nearby listings.

Return strict JSON only. Do not include markdown.

Rules:
- Use null if a value is missing.
- Do not guess.
- Convert prices and numbers to numeric values where possible.
- If HOA says "No HOA Fee", set hoa_fee_monthly to 0.
- Keep land lease separate from HOA.
- If the listing is a manufactured/mobile home in a park, preserve that property type.
- If lot size appears to describe a park/community rather than owned land, include a warning.
- Include short source snippets for important fields so we can debug extraction.
"""


def load_raw_scrape(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_listing(raw_scrape: dict) -> dict:
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    compact_input = {
        "url": raw_scrape.get("url"),
        "page_title": raw_scrape.get("page_title"),
        "meta": raw_scrape.get("meta", {}),
        "visible_text": raw_scrape.get("visible_text", ""),
    }

    schema_example = {
        "address": None,
        "city": None,
        "state": None,
        "zip": None,
        "price": None,
        "original_price": None,
        "beds": None,
        "baths": None,
        "sqft": None,
        "lot_size_text": None,
        "year_built": None,
        "property_type": None,
        "property_subtype": None,
        "hoa_fee_monthly": None,
        "land_lease_monthly": None,
        "listing_status": None,
        "days_on_market": None,
        "mls_number": None,
        "description": None,
        "source_url": None,
        "price_history": [
            {
                "date": None,
                "price": None,
                "event": None,
                "source": None
            }
        ],
        "warnings": [],
        "missing_fields": [],
        "source_snippets": {
            "price": None,
            "beds_baths_sqft": None,
            "property_type": None,
            "land_lease": None,
            "hoa": None,
            "year_built": None
        },
        "extraction_confidence": None
    }

    response = client.responses.create(
        model=EXTRACTION_MODEL,
        input=[
            {
                "role": "system",
                "content": LISTING_EXTRACTION_PROMPT,
            },
            {
                "role": "user",
                "content": (
                    "Extract the primary listing into this JSON shape:\n"
                    f"{json.dumps(schema_example, indent=2)}\n\n"
                    "Raw browser scrape:\n"
                    f"{json.dumps(compact_input, ensure_ascii=False)}"
                ),
            },
        ],
    )

    text = response.output_text.strip()
    return json.loads(text)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python extract_listing.py <raw_scrape_json>")

    input_path = sys.argv[1]
    raw_scrape = load_raw_scrape(input_path)
    listing = extract_listing(raw_scrape)

    output_path = Path(input_path).with_name("structured_listing.json")

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(listing, f, indent=2, ensure_ascii=False)

    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()