from datetime import date

_CURRENT_YEAR = date.today().year

_PERMIT_CONFIRMED = [
    "permitted", "permit pulled", "permits on file", "permitted addition",
    "all permits", "building permit", "city permit", "licensed and permitted",
    "up to code", "to current code", "fully permitted",
]

_PERMIT_CONCERN = [
    "no permit", "unpermitted", "without permit", "not permitted",
    "converted without", "added without", "no permits",
]

_RENOVATION_KEYWORDS = [
    "renovated", "remodeled", "updated", "upgraded", "addition",
    "converted", "finished basement", "finished attic", "added on",
    "expanded", "new addition", "gut renovation",
]

_SERVICE_KEYWORDS = [
    "serviced", "maintained", "annual service", "professionally maintained",
    "new hvac", "new roof", "replaced", "service records",
    "well maintained", "meticulously maintained", "lovingly maintained",
]

_RED_FLAG_KEYWORDS = [
    "as-is", "as is", "investor special", "handyman special",
    "priced to sell", "needs tlc", "needs work", "fixer",
    "deferred maintenance", "sold as-is",
]


def maintenance_history_risk(listing: dict) -> dict:
    section = "Maintenance & Permit History"
    signals: list[str] = []
    facts: list[str] = []
    concerns: list[str] = []
    questions: list[str] = []

    description   = (listing.get("description") or "").lower()
    year_built    = listing.get("year_built")
    property_type = (listing.get("property_type") or "").lower()

    home_age = (_CURRENT_YEAR - year_built) if year_built else None

    # ── Observed facts ────────────────────────────────────────────────────────
    has_permit_confirmed = any(kw in description for kw in _PERMIT_CONFIRMED)
    has_permit_concern   = any(kw in description for kw in _PERMIT_CONCERN)
    has_renovation       = any(kw in description for kw in _RENOVATION_KEYWORDS)
    has_service          = any(kw in description for kw in _SERVICE_KEYWORDS)
    has_red_flag         = any(kw in description for kw in _RED_FLAG_KEYWORDS)

    if year_built:
        facts.append(f"Built in {year_built} — approximately {home_age} years of maintenance history")
    if has_renovation:
        facts.append("Listing references renovations or structural updates")
    if has_permit_confirmed:
        facts.append("Listing states renovations were permitted or performed to code")
    if has_permit_concern:
        facts.append("Listing language suggests potentially unpermitted work")
    if has_service:
        facts.append("Listing references ongoing service or maintenance")
    if has_red_flag:
        facts.append("Listing uses language associated with deferred maintenance or as-is condition")
    if not any([has_renovation, has_permit_confirmed, has_service, has_red_flag]):
        facts.append("No maintenance or permit history disclosed in the listing")

    # ── Unpermitted / as-is signals ────────────────────────────────────────
    if has_permit_concern:
        signals.append(
            "[High] Listing language suggests unpermitted work — "
            "retroactive permitting, code remediation, or removal may be required"
        )
        concerns.append(
            "Unpermitted additions, conversions, or renovations can result in lender financing refusal, "
            "insurance complications, and forced removal at the owner's expense. "
            "Always pull the official permit record from the local building department before closing."
        )

    if has_red_flag:
        signals.append(
            "[High] As-is or deferred-maintenance language detected — "
            "unknown accumulated repair needs should be assumed"
        )
        concerns.append(
            "As-is listings often reflect known issues the seller prefers not to disclose or price in. "
            "Deferred maintenance compounds: a neglected roof accelerates HVAC and structural damage. "
            "Budget for a comprehensive pre-offer inspection and an independent contractor walk-through."
        )

    # ── Renovation without permit confirmation ────────────────────────────
    if has_renovation and not has_permit_confirmed and not has_permit_concern:
        signals.append(
            "[Medium] Renovations mentioned but permit status not confirmed — "
            "work may or may not be code-compliant"
        )
        concerns.append(
            "Renovations without documented permits may not meet current building code standards "
            "and can complicate homeowner's insurance claims or future resale inspections. "
            "Request permit records from the local building or planning department."
        )

    # ── Age-based permit gap ───────────────────────────────────────────────
    if home_age is not None:
        if home_age >= 30:
            signals.append(
                f"[Medium] Home is {home_age} years old — three decades of maintenance and "
                "renovation activity is unlikely to be fully documented"
            )
            concerns.append(
                "Homes with 30+ years of ownership history commonly have gaps in permit records, "
                "especially for interior remodels, basement finishes, and electrical or plumbing changes "
                "completed by prior owners. A title search and county permit lookup are strongly recommended."
            )
        elif home_age >= 15 and not has_service and not has_permit_confirmed:
            signals.append(
                f"[Medium] No maintenance records disclosed for a {home_age}-year-old home — "
                "service history is unverifiable"
            )
            concerns.append(
                "Without documented service history, you cannot confirm whether major systems "
                "(HVAC, roof, plumbing) received routine maintenance. Skipped maintenance shortens "
                "component lifespans and can void manufacturer warranties."
            )

    # ── Positive signal ────────────────────────────────────────────────────
    if has_permit_confirmed and not has_red_flag:
        label = "permitted work and ongoing maintenance" if has_service else "permitted construction or renovations"
        signals.append(
            f"[Low] Listing references {label} — "
            "documentation should be requested and verified at inspection"
        )

    # ── No signals at all ─────────────────────────────────────────────────
    if not signals:
        signals.append(
            "[Medium] Maintenance and permit history not disclosed — "
            "full record lookup recommended before closing"
        )
        concerns.append(
            "The absence of maintenance disclosures does not mean the home was neglected, "
            "but it leaves the buyer without evidence either way. "
            "Request all available service records and run a permit history check with the local municipality."
        )

    # ── Standard questions ─────────────────────────────────────────────────
    questions.append(
        "Can you provide the full permit history from the local building department, "
        "including any additions, conversions, or structural changes?"
    )
    questions.append(
        "Are there service records for major systems — HVAC, roof, plumbing, and electrical? "
        "Who performed the work and when?"
    )
    questions.append(
        "Have any insurance claims been filed on this property? "
        "If so, for what, and was the work fully remediated?"
    )
    if has_renovation:
        questions.append(
            "Were all renovations completed by licensed contractors, "
            "and are permits and final inspections on file?"
        )

    return {
        "section": section,
        "observed_facts": facts,
        "computed_risk_signals": signals,
        "inferred_concerns": concerns,
        "buyer_questions": questions,
    }
