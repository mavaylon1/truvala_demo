_HIGH_RISK_STATES = {
    "FL": "Florida — high hurricane, flood, and sinkhole exposure; major insurers have exited the market",
    "CA": "California — wildfire and earthquake risk; many insurers have stopped writing new policies",
    "LA": "Louisiana — hurricane and flood risk; insurance costs are among the highest nationally",
    "TX": "Texas — tornado, hail, and coastal hurricane exposure; flood risk in low-lying areas",
    "OK": "Oklahoma — tornado alley; hail and wind damage are frequent",
    "KS": "Kansas — tornado risk; hail damage is common",
    "NC": "North Carolina — coastal hurricane risk; inland flooding in storm events",
    "SC": "South Carolina — coastal hurricane and flood risk",
    "MS": "Mississippi — hurricane and flood exposure along the coast",
    "AL": "Alabama — hurricane and flood risk in coastal areas",
    "HI": "Hawaii — volcanic activity, hurricane, and tsunami risk depending on island and location",
}

_DISASTER_KEYWORDS = [
    "flood zone", "floodplain", "flood plain", "wildfire", "fire risk", "fire zone",
    "earthquake", "seismic", "hurricane", "tornado", "sinkhole", "fema",
    "special flood hazard", "high wind zone", "coastal", "storm surge",
]

_LAND_LEASE_KEYWORDS = [
    "land lease", "ground lease", "leasehold", "land rent", "lease the land",
    "you own the home", "you own the unit", "monthly land fee", "land payment",
    "co-op", "cooperative ownership",
]


def insurance_risk(listing: dict) -> dict:
    description = (listing.get("description") or "").lower()
    address = listing.get("address") or ""
    state_raw = listing.get("state") or ""
    state = state_raw.strip().upper()

    disaster_mentions = [kw for kw in _DISASTER_KEYWORDS if kw in description]
    land_lease_mentions = [kw for kw in _LAND_LEASE_KEYWORDS if kw in description]

    state_note = _HIGH_RISK_STATES.get(state, "")

    if disaster_mentions:
        disaster_signal = f"Natural disaster flag detected: '{disaster_mentions[0]}' in listing"
    else:
        disaster_signal = "Natural disaster history — verify area flood, wildfire, and storm exposure"

    if state_note:
        insurance_signal = f"Insurance availability: {state_note}"
    else:
        insurance_signal = (
            f"Insurance availability — verify state-specific coverage options and annual premiums"
            if not state else
            f"Insurance availability for {state_raw} — verify coverage options and annual premiums"
        )

    if land_lease_mentions:
        land_signal = f"Land lease detected: '{land_lease_mentions[0]}' — buyer pays land rent separately from mortgage"
    else:
        land_signal = "Land Lease — confirm whether buyer owns the land or pays ongoing ground rent"

    observed_facts = []
    if state_raw:
        observed_facts.append(f"State: {state_raw}")
    if address:
        observed_facts.append(f"Address: {address}")
    if disaster_mentions:
        observed_facts.append(f"Listing references: {', '.join(disaster_mentions[:3])}")
    if land_lease_mentions:
        observed_facts.append(f"Lease language detected: {', '.join(land_lease_mentions[:2])}")
    if not observed_facts:
        observed_facts.append("No state or address data available")

    return {
        "section": "Insurance",
        "observed_facts": observed_facts,
        "computed_risk_signals": [disaster_signal, insurance_signal, land_signal],
        "inferred_concerns": [
            "Insurance costs and availability vary significantly by location — verify before making an offer",
            "Land lease properties have ongoing land rent that increases over time and is not covered by a mortgage",
        ],
        "missing_information": [
            "FEMA flood zone designation for this address",
            "Estimated annual homeowner's insurance premium",
            "Land ownership vs. ground lease terms",
        ],
        "buyer_questions": [
            "Is this property in a FEMA special flood hazard area?",
            "What is the estimated annual homeowner's insurance premium from multiple carriers?",
            "Does the buyer own the land outright, or is there a ground lease with ongoing rent?",
        ],
    }
