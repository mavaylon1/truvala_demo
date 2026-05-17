# Each flag: patterns to match (lowercase), category, severity, signal, concern, question
_RED_FLAGS = [
    {
        "patterns": [
            "as-is", "as is", "sold as is", "selling as-is",
            "in its current condition",
        ],
        "category": "Repair / Disclosure Risk",
        "severity": "High",
        "signal": '"As-is" sale — seller is not committing to repairs or concessions',
        "concern": "Buyer assumes full repair responsibility; unknown defects may not be disclosed",
        "question": "What specifically is being sold as-is? Are there known defects the seller can disclose?",
    },
    {
        "patterns": [
            "cash only", "cash buyers only", "cash purchase only",
            "no financing",
        ],
        "category": "Financing / Condition Risk",
        "severity": "High",
        "signal": "Cash-only sale — often signals property will not pass standard lender appraisal",
        "concern": "Property may have condition issues that prevent standard mortgage approval",
        "question": "Why is financing restricted? What condition or appraisal issues are present?",
    },
    {
        "patterns": [
            "contractor special", "handyman special", "handyman's special",
            "needs work", "needs tlc", "tlc needed",
            "fixer-upper", "fixer upper",
            "bring your vision", "great bones", "diamond in the rough",
        ],
        "category": "Condition / Rehab Risk",
        "severity": "High",
        "signal": "Listing signals property requires significant rehabilitation",
        "concern": "Scope and cost of required work is undefined — budget risk is high",
        "question": "What is the estimated scope and cost of repairs needed? Has a contractor reviewed it?",
    },
    {
        "patterns": [
            "unpermitted", "un-permitted", "no permits", "without permit",
            "not permitted", "permit unknown",
        ],
        "category": "Permit / Legal Risk",
        "severity": "High",
        "signal": "Unpermitted work referenced in listing",
        "concern": "Buyer may inherit liability; local jurisdiction may require retroactive permitting or remediation",
        "question": "What work was done without permits? What does the local building department require to resolve this?",
    },
    {
        "patterns": [
            "buyer to verify", "buyer to confirm",
            "information deemed reliable but not guaranteed",
            "all information to be verified by buyer",
            "buyer is advised to independently verify",
        ],
        "category": "Information Uncertainty",
        "severity": "Medium",
        "signal": '"Buyer to verify" language — seller is not confirming stated facts',
        "concern": "Key property details may be approximate, estimated, or unverified by the seller",
        "question": "Which specific details need verification? Can the seller provide supporting documentation?",
    },
    {
        "patterns": [
            "tenant occupied", "occupied by tenant", "current tenant",
            "month-to-month tenant", "lease in place", "renter occupied",
        ],
        "category": "Possession / Timeline Risk",
        "severity": "Medium",
        "signal": "Property is currently tenant-occupied",
        "concern": "Possession timeline depends on lease terms and local tenant protection laws",
        "question": "What are the current lease terms? When can possession be obtained after closing?",
    },
    {
        "patterns": [
            "estate sale", "probate sale", "court approval required",
            "subject to court approval", "probate property",
        ],
        "category": "Process / Timeline Risk",
        "severity": "Medium",
        "signal": "Estate or probate sale — court approval may be required",
        "concern": "Closing timeline may extend significantly; seller has limited ability to negotiate",
        "question": "Is court approval required to close? What is the expected timeline to close?",
    },
    {
        "patterns": [
            "flood zone", "in a flood plain", "floodplain",
            "flood insurance required", "special flood hazard area", "fema zone",
        ],
        "category": "Environmental / Insurance Risk",
        "severity": "High",
        "signal": "Listing references flood zone designation",
        "concern": "Flood insurance is likely required and can add $1,000–$5,000+ annually to carrying costs",
        "question": "What is the exact FEMA flood zone? What is the estimated annual flood insurance premium?",
    },
    {
        "patterns": [
            "mold remediation", "mold issue", "mold present", "mold damage",
            "water damage", "water intrusion", "moisture issue",
            "moisture problem", "past flooding", "previous flooding", "wet basement",
            "water in basement",
        ],
        "category": "Moisture / Mold Risk",
        "severity": "High",
        "signal": "Moisture or mold language detected in listing",
        "concern": "Remediation can be extensive and expensive; may indicate ongoing structural water issues",
        "question": "Is there an active moisture issue? Has mold been professionally remediated? Are there warranties on the remediation?",
    },
    {
        "patterns": [
            "short sale", "subject to lender approval", "lender approval required",
            "short sale subject to",
        ],
        "category": "Transaction Risk",
        "severity": "High",
        "signal": "Short sale — subject to third-party lender approval",
        "concern": "Closing timeline is uncertain and can extend months; lender may counter or reject the agreed price",
        "question": "Has the lender already pre-approved the short sale price? What is the expected approval timeline?",
    },
    {
        "patterns": [
            "price reduced", "reduced price", "price drop", "motivated seller",
            "must sell", "priced to sell", "seller motivated",
        ],
        "category": "Market Signal",
        "severity": "Low",
        "signal": "Pricing pressure language — seller may be motivated to close",
        "concern": "Could indicate a negotiating opportunity, or an undisclosed reason for urgency",
        "question": "Why has the price been reduced? How long has the property been listed?",
    },
]


def listing_language_red_flags(listing: dict) -> dict:
    description = (listing.get("description") or "").lower()

    if not description:
        return {
            "section": "Listing Language Red Flags",
            "observed_facts": ["No listing description available to analyze"],
            "computed_risk_signals": ["Cannot perform language analysis without listing text"],
            "inferred_concerns": [],
            "missing_information": ["Listing description or agent remarks"],
            "buyer_questions": ["Can the agent provide full listing remarks and disclosures?"],
        }

    matched = []
    for flag in _RED_FLAGS:
        for pattern in flag["patterns"]:
            if pattern in description:
                matched.append((flag, pattern))
                break

    if not matched:
        return {
            "section": "Listing Language Red Flags",
            "observed_facts": ["No high-risk language patterns detected in listing description"],
            "computed_risk_signals": [],
            "inferred_concerns": [],
            "missing_information": [],
            "buyer_questions": [],
        }

    observed_facts = []
    signals = []
    concerns = []
    questions = []

    for flag, matched_phrase in matched:
        observed_facts.append(f'Listing contains: "{matched_phrase}"')
        signals.append(f"[{flag['severity']}] {flag['signal']}")
        concerns.append(flag["concern"])
        questions.append(flag["question"])

    return {
        "section": "Listing Language Red Flags",
        "observed_facts": observed_facts,
        "computed_risk_signals": signals,
        "inferred_concerns": concerns,
        "missing_information": [],
        "buyer_questions": questions,
    }
