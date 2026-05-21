from .helpers import normalize_key

# Internal weights for school level composite — buyer only tunes overall school importance
_SCHOOL_LEVEL_WEIGHTS = {"elementary": 0.50, "high": 0.30, "middle": 0.20}


def derive_school_rating(schools):
    """
    Weighted average of assigned/nearby school ratings.
    Weights: elementary 50%, high 30%, middle 20%.
    Schools without a rating are skipped.
    Missing levels have their weight redistributed among present levels.
    """
    if not schools:
        return None

    by_level = {}
    seen_names = set()
    for school in schools:
        raw_type = (school.get("type") or "").lower().strip()
        rating   = school.get("rating")
        name     = (school.get("name") or "").lower().strip()
        if rating is None:
            continue
        if "elementary" in raw_type:
            level = "elementary"
        elif "middle" in raw_type or "junior" in raw_type:
            level = "middle"
        elif "high" in raw_type:
            level = "high"
        else:
            continue  # district or unknown — skip

        # Deduplicate: same school name appearing under multiple levels
        # (e.g. a 7-12 school extracted as both middle and high)
        if name and name in seen_names:
            continue
        if name:
            seen_names.add(name)

        by_level.setdefault(level, []).append(float(rating))

    if not by_level:
        return None

    # Average within each level, then weight across levels
    level_avg = {lvl: sum(ratings) / len(ratings) for lvl, ratings in by_level.items()}
    present   = {lvl: _SCHOOL_LEVEL_WEIGHTS[lvl] for lvl in level_avg if lvl in _SCHOOL_LEVEL_WEIGHTS}
    total_w   = sum(present.values())
    if total_w == 0:
        return None

    composite = sum(level_avg[lvl] * w for lvl, w in present.items()) / total_w
    return round(composite, 1)


def normalize_listing(raw_listing):
    """
    Converts raw listing JSON into the internal field names used by the scorer.

    Keep this intentionally simple at first. This is where messy source-specific
    fields from Trulia, Zillow, MLS, RentCast, etc. should get normalized.
    """

    property_type = raw_listing.get("property_type")
    property_subtype = raw_listing.get("property_subtype")

    normalized_type = normalize_property_type(property_type, property_subtype)

    return {
        "address": raw_listing.get("address"),
        "city": raw_listing.get("city"),
        "state": raw_listing.get("state"),
        "zip": raw_listing.get("zip"),

        "price": raw_listing.get("price"),
        "bedrooms": raw_listing.get("beds"),
        "bathrooms": raw_listing.get("baths"),
        "sqft": raw_listing.get("sqft"),
        "year_built": raw_listing.get("year_built"),

        "property_type": normalized_type,

        # These may be missing from scraped listing JSON.
        # They can be filled later by geocoding, routing, school API, etc.
        "distance_miles": raw_listing.get("distance_miles"),
        "floors": normalize_key(raw_listing.get("floors")),
        "school_rating": derive_school_rating(raw_listing.get("schools") or []),
        "school_district": raw_listing.get("school_district"),

        # Not part of Buyer Fit v1 yet, but useful for explanations/debugging.
        "hoa_fee_monthly": raw_listing.get("hoa_fee_monthly"),
        "land_lease_monthly": raw_listing.get("land_lease_monthly"),
        "days_on_market": raw_listing.get("days_on_market"),
        "source_url": raw_listing.get("source_url"),
    }


def normalize_property_type(property_type, property_subtype=None):
    combined = " ".join(
        str(value) for value in [property_type, property_subtype] if value
    ).lower()

    if "manufactured" in combined and "park" in combined:
        return "manufactured_in_park"

    if "manufactured" in combined or "mobile" in combined:
        return "manufactured_home"

    if "single" in combined and "family" in combined:
        return "single_family"

    if "town" in combined:
        return "townhouse"

    if "condo" in combined:
        return "condo"

    if "land" in combined or "lot" in combined:
        return "land"

    return normalize_key(property_type) or "unknown"
