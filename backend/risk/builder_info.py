from datetime import date

_CURRENT_YEAR = date.today().year

# Known builders with documented quality/complaint patterns
_KNOWN_BUILDERS = {
    "dr horton": "D.R. Horton",
    "lennar": "Lennar",
    "pulte": "Pulte Homes",
    "kb home": "KB Home",
    "ryan homes": "Ryan Homes / NVR",
    "meritage": "Meritage Homes",
    "toll brothers": "Toll Brothers",
    "centex": "Centex",
    "beazer": "Beazer Homes",
    "taylor morrison": "Taylor Morrison",
    "smith douglas": "Smith Douglas Homes",
    "century communities": "Century Communities",
}

_PERMIT_KEYWORDS = [
    "permitted", "permit pulled", "permits pulled", "licensed contractor",
    "up to code", "to current code", "city approved",
]

_WARRANTY_KEYWORDS = [
    "builder warranty", "new home warranty", "structural warranty",
    "2-10 warranty", "warranty transferable", "warranty transfers",
]


def builder_info_risk(listing: dict) -> dict:
    section = "Builder & Developer"
    signals: list[str] = []
    facts: list[str] = []
    concerns: list[str] = []
    questions: list[str] = []

    year_built   = listing.get("year_built")
    description  = (listing.get("description") or "").lower()
    builder      = listing.get("builder") or listing.get("developer") or ""
    property_type = (listing.get("property_type") or "").lower()
    hoa          = listing.get("hoa")

    home_age = (_CURRENT_YEAR - year_built) if year_built else None

    # ── Observed facts ────────────────────────────────────────────────────────
    if year_built:
        facts.append(f"Built in {year_built}")
    if builder:
        facts.append(f"Builder on record: {builder}")
    else:
        # Try to detect builder name in description
        matched = next((v for k, v in _KNOWN_BUILDERS.items() if k in description), None)
        if matched:
            facts.append(f"Builder reference detected in listing: {matched}")
            builder = matched
        else:
            facts.append("Builder name not disclosed in listing")

    has_permit_language = any(kw in description for kw in _PERMIT_KEYWORDS)
    has_warranty_language = any(kw in description for kw in _WARRANTY_KEYWORDS)
    if has_permit_language:
        facts.append("Listing references permitted construction or licensed contractors")
    if has_warranty_language:
        facts.append("Listing mentions a builder or structural warranty")

    # ── New construction (≤5 years) ────────────────────────────────────────
    if home_age is not None and home_age <= 5:
        signals.append(
            "[High] New construction — builder quality, punchlist completion, "
            "and warranty coverage require active verification"
        )
        concerns.append(
            "Newly built homes can have latent defects that surface 1–3 years after move-in. "
            "Builder responsiveness to warranty claims varies significantly by company. "
            "A third-party new-construction inspection before closing is strongly recommended."
        )
        if not has_warranty_language:
            signals.append(
                "[Medium] No warranty information disclosed — builder warranty status unknown"
            )
            concerns.append(
                "Most new-construction builders offer a 1-year workmanship, 2-year mechanical, "
                "and 10-year structural warranty. Without disclosure, transferability and remaining "
                "coverage cannot be confirmed."
            )
        questions.append("Is the builder warranty still active, and does it transfer to a new buyer?")
        questions.append("Have any punchlist or warranty service items been completed and documented?")

    # ── Mid-age (6–15 years) ──────────────────────────────────────────────
    elif home_age is not None and home_age <= 15:
        signals.append(
            "[Medium] Home is 6–15 years old — builder warranty likely expired or near expiry; "
            "check for latent defect history"
        )
        concerns.append(
            "Most builder structural warranties expire at year 10. "
            "This window is when latent construction defects — settlement cracks, waterproofing failures, "
            "HVAC installation issues — commonly surface. Review any HOA or prior-owner complaint records."
        )
        questions.append(
            "Were there any builder callbacks, warranty claims, or known construction defects "
            "within the first 10 years?"
        )

    # ── Older home (>15 years) ─────────────────────────────────────────────
    elif home_age is not None and home_age > 15:
        signals.append(
            "[Low] Home is over 15 years old — original builder warranty expired; "
            "construction quality is reflected in current condition"
        )
        concerns.append(
            "For older homes, builder reputation matters less than current physical condition. "
            "Focus inspection attention on any additions or renovations made since original construction."
        )

    # ── Unknown builder ────────────────────────────────────────────────────
    if not builder:
        signals.append(
            "[Medium] Builder not disclosed — reputation, complaint history, "
            "and warranty status cannot be assessed without additional research"
        )
        concerns.append(
            "Undisclosed builders are common in resale listings but limit your ability to check "
            "BBB complaint records, class-action history, or HOA construction dispute filings. "
            "The county assessor or building permit records typically name the original builder."
        )
        questions.append(
            "Can the listing agent provide the original builder's name and any known construction issues?"
        )

    # ── Developer-controlled HOA ───────────────────────────────────────────
    if hoa and home_age is not None and home_age <= 7:
        signals.append(
            "[Medium] HOA may still be developer-controlled — homeowner governance rights could be limited"
        )
        concerns.append(
            "Developers typically retain HOA control for 3–7 years post-build. During this period, "
            "the developer controls budget, rules, and maintenance decisions — sometimes prioritizing "
            "sales over resident interests."
        )
        questions.append(
            "Has the HOA transitioned from developer to homeowner control? "
            "Are there any outstanding common-area construction disputes?"
        )

    # ── Standard questions always worth asking ─────────────────────────────
    questions.append(
        "Are there any pending or prior construction defect lawsuits, class actions, "
        "or builder complaints on record for this development?"
    )

    return {
        "section": section,
        "observed_facts": facts,
        "computed_risk_signals": signals,
        "inferred_concerns": concerns,
        "buyer_questions": questions,
    }
