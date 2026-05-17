from datetime import date

_CURRENT_YEAR = date.today().year

_COMPONENTS = [
    {
        "name": "Roof",
        "lifespan": (20, 30),
        "replacement_cost": "$15,000–$40,000",
        "priority": "High",
        "why": "Roof replacement is one of the largest near-term costs a buyer can face",
        "keywords_updated": [
            "new roof", "roof replaced", "roof updated", "new shingles", "reroof",
            "re-roof", "replaced the roof", "replaced roof",
        ],
        "missing_label": "Roof age or replacement date",
        "question": "When was the roof last replaced? What material is it?",
    },
    {
        "name": "HVAC",
        "lifespan": (15, 20),
        "replacement_cost": "$8,000–$20,000",
        "priority": "High",
        "why": "Older HVAC systems can fail with little warning and are expensive to replace",
        "keywords_updated": [
            "new hvac", "new ac", "new furnace", "hvac replaced", "new heating",
            "new cooling", "new air conditioning", "new heat pump", "replaced hvac",
            "updated hvac", "new central air", "new central heat", "new mechanical",
        ],
        "missing_label": "HVAC age or replacement date",
        "question": "When was the HVAC system last replaced or professionally serviced?",
    },
    {
        "name": "Water Heater",
        "lifespan": (10, 15),
        "replacement_cost": "$1,500–$5,000",
        "priority": "Medium",
        "why": "Water heaters near end of lifespan fail unexpectedly and are a common oversight",
        "keywords_updated": [
            "new water heater", "water heater replaced", "new hot water heater",
            "tankless water heater", "new tankless", "replaced water heater",
        ],
        "missing_label": "Water heater age",
        "question": "How old is the water heater? Is it a tank or tankless unit?",
    },
    {
        "name": "Electrical Panel",
        "lifespan": (30, 40),
        "replacement_cost": "$3,000–$8,000",
        "priority": "High",
        "why": "Older panels (especially FPE/Zinsco brands) can be fire hazards and may be uninsurable",
        "keywords_updated": [
            "new electrical panel", "panel upgraded", "electrical upgraded",
            "new panel", "updated electrical", "200 amp", "200-amp", "400 amp",
            "upgraded panel", "new breaker",
        ],
        "missing_label": "Electrical panel age or upgrade history",
        "question": "Has the electrical panel been upgraded? What is the amperage, and what brand is it?",
    },
    {
        "name": "Windows",
        "lifespan": (20, 25),
        "replacement_cost": "$8,000–$25,000",
        "priority": "Medium",
        "why": "Single-pane or aging windows significantly impact energy costs and comfort",
        "keywords_updated": [
            "new windows", "windows replaced", "updated windows", "double pane",
            "double-pane", "triple pane", "triple-pane", "energy efficient windows",
            "new window", "replaced windows", "vinyl windows",
        ],
        "missing_label": "Window age and type (single vs double-pane)",
        "question": "What type of windows are installed? When were they last replaced?",
    },
    {
        "name": "Plumbing",
        "lifespan": (40, 70),
        "replacement_cost": "$5,000–$20,000",
        "priority": "High",
        "why": "Polybutylene or galvanized pipe can fail unexpectedly and affects insurability",
        "keywords_updated": [
            "new plumbing", "plumbing replaced", "updated plumbing", "copper plumbing",
            "pex plumbing", "repiped", "re-piped", "replaced plumbing",
        ],
        "missing_label": "Plumbing material and condition",
        "question": "What type of plumbing is installed? Has it been replaced from the original?",
    },
]


def _mentions_update(description: str, keywords: list[str]) -> bool:
    if not description:
        return False
    text = description.lower()
    return any(kw in text for kw in keywords)


def component_lifespan_risk(listing: dict) -> dict:
    year_built = listing.get("year_built")
    description = (listing.get("description") or "").lower()

    observed_facts = []
    signals = []
    missing = []
    questions = []

    if year_built:
        observed_facts.append(f"Built in {year_built}")
    else:
        observed_facts.append("Year built not available — component age estimates not possible")

    for comp in _COMPONENTS:
        updated = _mentions_update(description, comp["keywords_updated"])

        if updated:
            observed_facts.append(
                f"{comp['name']}: listing indicates recent update or replacement — no date confirmed"
            )
            # Still track: we want the date, and the cost table key must match exactly
            missing.append(comp["missing_label"])
        else:
            if year_built:
                estimated_age = _CURRENT_YEAR - year_built
                lo, hi = comp["lifespan"]

                if estimated_age >= lo:
                    signals.append(
                        f"{comp['name']}: estimated age {estimated_age} yrs — "
                        f"typical lifespan {lo}–{hi} yrs; replacement verification recommended"
                    )
                elif estimated_age >= int(lo * 0.75):
                    signals.append(
                        f"{comp['name']}: estimated age {estimated_age} yrs — "
                        f"approaching typical lifespan of {lo}–{hi} yrs"
                    )
                else:
                    observed_facts.append(
                        f"{comp['name']}: estimated age {estimated_age} yrs — within typical lifespan"
                    )
            else:
                signals.append(f"{comp['name']}: age unknown — cannot assess lifespan without build year")

            missing.append(comp["missing_label"])
            questions.append(comp["question"])

    inferred_concerns = []
    if signals:
        inferred_concerns.append(
            "If flagged systems have not been recently replaced, buyer may face near-term replacement costs"
        )
        inferred_concerns.append(
            "The risk is not that these systems are confirmed bad — it is that their actual ages and conditions are unverified"
        )

    return {
        "section": "Component Lifespan Risk",
        "observed_facts": observed_facts,
        "computed_risk_signals": signals,
        "inferred_concerns": inferred_concerns,
        "missing_information": missing,
        "buyer_questions": questions,
    }
