_COST_TABLE = {
    "Roof age or replacement date": {
        "why": "Roof replacement is one of the largest near-term costs a buyer can face",
        "estimate": "$15,000–$40,000",
        "ask": "Seller or inspector",
        "priority": "High",
    },
    "HVAC age or replacement date": {
        "why": "Older HVAC systems can fail with little warning and are expensive to replace",
        "estimate": "$8,000–$20,000",
        "ask": "Seller, inspector, or HVAC contractor",
        "priority": "High",
    },
    "Water heater age": {
        "why": "Water heaters near end of lifespan fail unexpectedly",
        "estimate": "$1,500–$5,000",
        "ask": "Seller or inspector",
        "priority": "Medium",
    },
    "Electrical panel age or upgrade history": {
        "why": "Older panels can be a fire hazard and may make the home uninsurable",
        "estimate": "$3,000–$8,000",
        "ask": "Seller, inspector, or licensed electrician",
        "priority": "High",
    },
    "Window age and type (single vs double-pane)": {
        "why": "Single-pane or aging windows significantly affect energy costs and comfort",
        "estimate": "$8,000–$25,000 for full replacement",
        "ask": "Seller or inspector",
        "priority": "Medium",
    },
    "Plumbing material and condition": {
        "why": "Polybutylene or galvanized pipe can fail and affect insurability",
        "estimate": "$5,000–$20,000 for full repipe",
        "ask": "Seller, inspector, or plumber",
        "priority": "High",
    },
    "Electrical wiring type and upgrade history": {
        "why": "Aluminum or knob-and-tube wiring is a safety and insurance concern",
        "estimate": "$8,000–$30,000 to rewire",
        "ask": "Seller or licensed electrician",
        "priority": "High",
    },
    "Electrical wiring type (aluminum vs copper)": {
        "why": "Aluminum wiring requires specific remediation to be safe and insurable",
        "estimate": "$3,000–$15,000 depending on scope",
        "ask": "Seller or licensed electrician",
        "priority": "High",
    },
    "Permit history for major updates": {
        "why": "Unpermitted work can create liability and complicate resale",
        "estimate": "Varies — retroactive permitting or remediation costs unpredictable",
        "ask": "Listing agent or local building department",
        "priority": "High",
    },
    "Permit history": {
        "why": "No permit history means major updates cannot be verified as code-compliant",
        "estimate": "Varies",
        "ask": "Listing agent or local building department",
        "priority": "High",
    },
    "Environmental assessment (lead, asbestos)": {
        "why": "Lead paint and asbestos remediation can be significant depending on scope",
        "estimate": "$1,500–$30,000+ depending on scope",
        "ask": "Certified environmental inspector",
        "priority": "High",
    },
    "Plumbing material (polybutylene vs copper/PVC)": {
        "why": "Polybutylene has a documented failure history and insurers may decline to cover it",
        "estimate": "$5,000–$20,000 to repipe",
        "ask": "Seller, inspector, or plumber",
        "priority": "High",
    },
    "Foundation type and recent inspection": {
        "why": "Foundation issues are among the most expensive repairs a buyer can face",
        "estimate": "$5,000–$100,000+ depending on severity",
        "ask": "Structural engineer or foundation specialist",
        "priority": "High",
    },
    "Builder warranty status and expiration": {
        "why": "An active builder warranty can cover significant defects at no cost",
        "estimate": "N/A — opportunity cost if warranty exists and is not used",
        "ask": "Builder or listing agent",
        "priority": "Medium",
    },
    "Lead and asbestos disclosure": {
        "why": "Required federal disclosure for pre-1978 homes; missing it is a legal red flag",
        "estimate": "$500–$5,000 for assessment; remediation varies",
        "ask": "Listing agent — seller is legally required to disclose for pre-1978 homes",
        "priority": "High",
    },
    "Exterior cladding type if stucco-finished": {
        "why": "EIFS (synthetic stucco) has a known moisture infiltration history in this era",
        "estimate": "$10,000–$50,000+ to remediate moisture damage",
        "ask": "Inspector or stucco specialist",
        "priority": "Medium",
    },
    "Drywall origin if built 2001–2009 in Gulf Coast states": {
        "why": "Chinese drywall from this era causes corrosion and off-gassing",
        "estimate": "$80,000–$150,000+ for full remediation",
        "ask": "Inspector with Chinese drywall testing experience",
        "priority": "High",
    },
    "Year built": {
        "why": "Build year is required to assess era-specific material and system risks",
        "estimate": "N/A",
        "ask": "Listing agent or county records",
        "priority": "High",
    },
}

_PRIORITY_ORDER = {"High": 0, "Medium": 1, "Low": 2}


def missing_info_checklist(age: dict, components: dict, language: dict) -> dict:
    # Collect and deduplicate all missing items across modules
    seen = set()
    all_missing = []
    for module in [age, components, language]:
        for item in module.get("missing_information", []):
            # Normalize for deduplication: strip parenthetical sub-notes
            key = item.split("(")[0].strip()
            if key not in seen:
                seen.add(key)
                all_missing.append(item)

    # Build checklist items with cost context
    checklist = []
    for item in all_missing:
        key = item.split("(")[0].strip()
        info = _COST_TABLE.get(key) or _COST_TABLE.get(item, {
            "why": "Required to fully assess property risk",
            "estimate": "Unknown",
            "ask": "Seller, agent, or inspector",
            "priority": "Medium",
        })
        checklist.append({
            "item": item,
            "why_it_matters": info["why"],
            "rough_estimate": info["estimate"],
            "ask": info["ask"],
            "priority": info["priority"],
        })

    checklist.sort(key=lambda x: _PRIORITY_ORDER.get(x["priority"], 99))

    # Deduplicate questions across all modules (preserve order)
    seen_q = set()
    all_questions = []
    for module in [age, components, language]:
        for q in module.get("buyer_questions", []):
            if q not in seen_q:
                all_questions.append(q)
                seen_q.add(q)

    high = [i for i in checklist if i["priority"] == "High"]
    medium = [i for i in checklist if i["priority"] == "Medium"]

    observed_facts = [
        f"{len(checklist)} key facts were not confirmed in the listing or available data"
    ]

    signals = []
    if high:
        signals.append(f"{len(high)} high-priority items require verification before making an offer")
    if medium:
        signals.append(f"{len(medium)} medium-priority items should be clarified before or during inspection")

    inferred_concerns = []
    if checklist:
        inferred_concerns.append(
            "Buyer cannot accurately estimate near-term cost exposure without confirming these items"
        )
        inferred_concerns.append(
            "Inspection and due diligence contingencies are strongly recommended given the number of unconfirmed facts"
        )

    return {
        "section": "Missing Information & Verification Checklist",
        "observed_facts": observed_facts,
        "computed_risk_signals": signals,
        "inferred_concerns": inferred_concerns,
        "missing_information": [i["item"] for i in checklist],
        "buyer_questions": all_questions[:8],
        "checklist": checklist,
    }
