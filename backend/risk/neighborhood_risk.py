_CRIME_KEYWORDS = [
    "crime", "safe", "safety", "gated", "security", "neighborhood watch",
    "surveillance", "low crime", "high crime", "police", "patrol",
]

_TRAFFIC_KEYWORDS = [
    "traffic", "commute", "highway", "freeway", "interstate", "busy street",
    "quiet street", "cul-de-sac", "noise", "walk score", "walkable",
    "transit", "public transportation", "bus stop", "train station",
]


def neighborhood_risk(listing: dict) -> dict:
    description = (listing.get("description") or "").lower()
    address = listing.get("address") or ""

    crime_mentions = [kw for kw in _CRIME_KEYWORDS if kw in description]
    traffic_mentions = [kw for kw in _TRAFFIC_KEYWORDS if kw in description]

    if crime_mentions:
        crime_signal = f"Crime Rate: listing mentions '{crime_mentions[0]}' — verify local statistics"
    else:
        crime_signal = f"Crime Rate: no data in listing — verify within 5 miles of this address"

    if traffic_mentions:
        traffic_signal = f"Traffic & Commute: listing mentions '{traffic_mentions[0]}' — verify commute times"
    else:
        traffic_signal = f"Traffic & Commute: no data in listing — verify rush-hour commute to nearest city"

    observed_facts = [
        f"Property address: {address}" if address else "Address not provided in listing",
    ]
    if crime_mentions:
        observed_facts.append(f"Listing references neighborhood context: {', '.join(crime_mentions[:3])}")
    if traffic_mentions:
        observed_facts.append(f"Listing references transit/traffic context: {', '.join(traffic_mentions[:3])}")

    return {
        "section": "Neighborhood",
        "observed_facts": observed_facts,
        "computed_risk_signals": [crime_signal, traffic_signal],
        "inferred_concerns": [
            "Crime and traffic data are not included in listing details — always verify with local sources before closing",
        ],
        "missing_information": [
            "Crime statistics within 5 miles of this address",
            "Peak-hour commute time to the nearest major city center",
        ],
        "buyer_questions": [
            "What is the crime rate in this zip code compared to the national average?",
            "What is the typical commute time during morning rush hour to the nearest major city?",
        ],
    }
