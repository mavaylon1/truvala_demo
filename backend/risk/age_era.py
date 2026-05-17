from datetime import date

# Each bucket: (min_year, max_year) inclusive, None = open-ended
_ERA_RULES = [
    {
        "range": (None, 1939),
        "label": "Pre-1940",
        "signals": [
            "Knob-and-tube wiring likely — not accepted by many modern insurers",
            "Pre-1978 lead paint risk applies",
            "Pre-1980 asbestos-era materials likely (insulation, floor tiles, pipe wrap)",
            "Galvanized or cast iron plumbing — corrosion and restricted flow risk",
            "Foundation may be unreinforced masonry, rubble, or early concrete",
        ],
        "concerns": [
            "Home is old enough to have gone through multiple full replacement cycles — update history unconfirmed",
            "Insurance may be more difficult or expensive without confirmed electrical update",
            "Environmental hazards (lead, asbestos) may require professional assessment before any renovation",
        ],
        "missing": [
            "Electrical wiring type and upgrade history",
            "Plumbing material and condition",
            "Foundation type and recent inspection",
            "Permit history for major updates",
            "Environmental assessment (lead, asbestos)",
        ],
        "questions": [
            "Has the electrical system been fully rewired?",
            "What type of plumbing is installed?",
            "Has a lead or asbestos assessment been completed?",
            "Has the foundation been inspected recently?",
            "Are permits on record for major renovations?",
        ],
    },
    {
        "range": (1940, 1959),
        "label": "1940–1959",
        "signals": [
            "Pre-1978 lead paint risk applies",
            "Pre-1980 asbestos-era materials possible (insulation, tiles, pipe wrap)",
            "Aluminum wiring possible in late-1950s construction",
            "Galvanized steel plumbing common — potential corrosion and flow restriction",
            "Post-war builder-grade construction quality varies widely",
        ],
        "concerns": [
            "Home may have had one or two replacement cycles — update history unconfirmed",
            "Aluminum wiring (if present) requires co-ALUM-rated outlets or pigtailing for safety and insurability",
        ],
        "missing": [
            "Electrical wiring type (aluminum vs copper)",
            "Plumbing material",
            "Permit history",
            "Lead and asbestos disclosure",
        ],
        "questions": [
            "What type of wiring is in the home — copper or aluminum?",
            "What type of plumbing is installed?",
            "Are there lead or asbestos disclosures on file?",
            "Are permits on record for major updates?",
        ],
    },
    {
        "range": (1960, 1977),
        "label": "1960–1977",
        "signals": [
            "Pre-1978 lead paint risk applies",
            "Pre-1980 asbestos-era materials possible (vermiculite insulation, vinyl floor tiles)",
            "Aluminum wiring peak era (1965–1973) — verify electrical panel and outlets",
            "Polybutylene plumbing may be present in late-1970s construction",
        ],
        "concerns": [
            "Aluminum wiring era — if present and unaddressed, this is both an insurance and a safety concern",
            "Systems may be original and approaching or past typical lifespan",
        ],
        "missing": [
            "Electrical wiring type (aluminum vs copper)",
            "Electrical panel age and upgrade history",
            "Plumbing material",
            "Permit history for updates",
            "Asbestos assessment for attic insulation and floor tiles",
        ],
        "questions": [
            "Is the wiring copper or aluminum?",
            "Has the electrical panel been upgraded?",
            "What type of plumbing is installed?",
            "Has the attic insulation been tested for asbestos?",
        ],
    },
    {
        "range": (1978, 1989),
        "label": "1978–1989",
        "signals": [
            "Polybutylene plumbing peak era (1978–1995) — known failure and class-action recall history",
            "Early EIFS (synthetic stucco) in some homes — moisture infiltration risk",
            "Post-lead-paint-ban construction but verify any older components",
            "Original systems are likely at or approaching end of typical lifespan",
        ],
        "concerns": [
            "Polybutylene plumbing (if present) has a documented failure history — many insurers decline to cover homes with it",
            "If original HVAC, roof, and water heater have not been replaced, near-term costs are likely",
        ],
        "missing": [
            "Plumbing material (polybutylene vs copper/PVC)",
            "Roof replacement date",
            "HVAC replacement date",
            "Exterior cladding type if stucco-finished",
        ],
        "questions": [
            "What type of plumbing is installed — has polybutylene been replaced?",
            "When was the roof last replaced?",
            "When was the HVAC last replaced?",
            "Is the exterior an EIFS/synthetic stucco finish? If so, has moisture testing been done?",
        ],
    },
    {
        "range": (1990, 2009),
        "label": "1990–2009",
        "signals": [
            "Generally post-major-era material risks",
            "Polybutylene plumbing still possible in early-1990s construction",
            "Chinese drywall possible in 2001–2009 construction (particularly Gulf Coast states)",
            "Original systems may be reaching end of lifespan depending on exact year",
        ],
        "concerns": [
            "If original HVAC and water heater have not been replaced, replacement may be near",
            "Chinese drywall (2001–2009 vintage) can cause corrosion and off-gassing — verify if built in an affected region",
        ],
        "missing": [
            "Plumbing material if built before 1995",
            "Drywall origin if built 2001–2009 in Gulf Coast states",
            "HVAC replacement date",
            "Water heater replacement date",
        ],
        "questions": [
            "Has the HVAC been replaced since original installation?",
            "How old is the water heater?",
            "If built 2001–2009 in a Gulf Coast state, has the drywall been verified as non-Chinese-import?",
            "What type of plumbing is installed if built before 1995?",
        ],
    },
    {
        "range": (2010, None),
        "label": "2010+",
        "signals": [
            "Built to modern construction codes",
            "Minimal historical material risk flags",
        ],
        "concerns": [
            "Newer homes can still have builder-quality issues or warranty expiration concerns",
            "Original systems are within expected lifespan but should be confirmed",
        ],
        "missing": [
            "Builder warranty status and expiration",
            "Known construction defects or builder callbacks",
        ],
        "questions": [
            "Is any builder warranty still active?",
            "Have there been any known construction defects or builder service callbacks?",
        ],
    },
]


def _get_era(year_built: int) -> dict | None:
    for rule in _ERA_RULES:
        lo, hi = rule["range"]
        if (lo is None or year_built >= lo) and (hi is None or year_built <= hi):
            return rule
    return None


def age_era_risk(listing: dict) -> dict:
    year_built = listing.get("year_built")
    current_year = date.today().year

    if not year_built:
        return {
            "section": "Age & Era Risk",
            "observed_facts": ["Year built not found in listing data"],
            "computed_risk_signals": ["Cannot perform era-based risk analysis without build year"],
            "inferred_concerns": ["Missing build year prevents flagging known era-specific material risks"],
            "missing_information": ["Year built"],
            "buyer_questions": ["What year was the home built?"],
        }

    home_age = current_year - year_built
    era = _get_era(year_built)

    observed_facts = [
        f"Built in {year_built}",
        f"Home is approximately {home_age} years old",
    ]
    if listing.get("property_type"):
        observed_facts.append(f"Property type: {listing['property_type']}")

    if not era:
        return {
            "section": "Age & Era Risk",
            "observed_facts": observed_facts,
            "computed_risk_signals": [],
            "inferred_concerns": [],
            "missing_information": [],
            "buyer_questions": [],
        }

    return {
        "section": "Age & Era Risk",
        "observed_facts": observed_facts,
        "computed_risk_signals": era["signals"],
        "inferred_concerns": era["concerns"],
        "missing_information": era["missing"],
        "buyer_questions": era["questions"],
    }
