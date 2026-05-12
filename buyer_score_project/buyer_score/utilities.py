from .helpers import clamp, linear_interpolate, normalize_key


def price_utility(price, max_price, cfg):
    """
    Curve-based utility.

    At/below budget gets full credit.
    Slightly over budget gets a soft penalty.
    Meaningfully over budget decays toward zero.
    """

    if price is None:
        return cfg["missing_utility"], "Price is missing, so a neutral utility was used."

    if price <= max_price:
        return 1.00, "Property is at or below the buyer's max budget."

    over_pct = (price - max_price) / max_price
    soft = cfg["soft_over_budget_pct"]
    hard = cfg["hard_over_budget_pct"]

    if over_pct >= hard:
        return cfg["utility_at_hard_limit"], "Property is far above the buyer's max budget."

    if over_pct <= soft:
        utility = linear_interpolate(
            over_pct,
            0.0,
            1.0,
            soft,
            cfg["utility_at_soft_limit"],
        )
        return clamp(utility), "Property is slightly above the buyer's max budget."

    utility = linear_interpolate(
        over_pct,
        soft,
        cfg["utility_at_soft_limit"],
        hard,
        cfg["utility_at_hard_limit"],
    )

    return clamp(utility), "Property is meaningfully above the buyer's max budget."


def bedrooms_utility(bedrooms, min_bedrooms, cfg):
    """
    Step-based utility.

    Bedrooms are usually discrete. Missing one bedroom is not the same as
    being 5% short, so a hard-coded formula is less natural here.
    """

    if bedrooms is None:
        return cfg["missing_utility"], "Bedroom count is missing, so a neutral utility was used."

    missing = max(0, int(min_bedrooms - bedrooms))
    utilities = cfg["utilities_by_missing_count"]

    if missing == 0:
        return float(utilities["0"]), "Property meets or exceeds the bedroom requirement."

    if missing == 1:
        return float(utilities["1"]), "Property is missing one bedroom versus the buyer's preference."

    if missing == 2:
        return float(utilities["2"]), "Property is missing two bedrooms versus the buyer's preference."

    return float(utilities["3+"]), "Property is missing three or more bedrooms versus the buyer's preference."


def bathrooms_utility(bathrooms, min_bathrooms, cfg):
    """
    Penalty utility.

    Bathrooms are semi-discrete because half baths matter.
    This uses a simple penalty function instead of fixed steps.
    """

    if bathrooms is None:
        return cfg["missing_utility"], "Bathroom count is missing, so a neutral utility was used."

    if bathrooms >= min_bathrooms:
        return 1.00, "Property meets or exceeds the bathroom requirement."

    missing = min_bathrooms - bathrooms
    full_baths_missing = int(missing)
    half_bath_missing = 1 if missing - full_baths_missing >= 0.5 else 0

    penalty = (
        full_baths_missing * cfg["missing_full_bath_penalty"]
        + half_bath_missing * cfg["missing_half_bath_penalty"]
    )

    utility = max(cfg["minimum_utility"], 1.0 - penalty)
    return clamp(utility), "Property has fewer bathrooms than the buyer prefers."


def compatibility_matrix_utility(actual_value, desired_value, cfg, field_label):
    """
    Matrix-based utility for categorical fields.

    This is better than one-hot matching because categories can be partially
    compatible. Example: townhouse can be a partial match for single-family.
    """

    actual_key = normalize_key(actual_value) or "unknown"
    desired_key = normalize_key(desired_value) or "unknown"

    matrix = cfg["compatibility_matrix"]
    default = cfg.get("default_unknown_utility", 0.50)

    utility = matrix.get(desired_key, {}).get(actual_key, default)

    if utility == 1.0:
        explanation = f"{field_label} matches the buyer's preference."
    elif utility >= 0.65:
        explanation = f"{field_label} is a strong partial match for the buyer's preference."
    elif utility >= 0.35:
        explanation = f"{field_label} is a weak partial match for the buyer's preference."
    else:
        explanation = f"{field_label} does not fit the buyer's preference well."

    return float(utility), explanation


def distance_utility(distance_miles, max_distance_miles, cfg):
    """
    Curve-based utility.

    Distance behaves like price: slightly outside the target may be acceptable,
    but utility should decay as distance gets worse.
    """

    if distance_miles is None:
        return cfg["missing_utility"], "Distance is missing, so a neutral utility was used."

    if distance_miles <= max_distance_miles:
        return 1.00, "Property is within the buyer's target distance."

    over_pct = (distance_miles - max_distance_miles) / max_distance_miles
    soft = cfg["soft_over_target_pct"]
    hard = cfg["hard_over_target_pct"]

    if over_pct >= hard:
        return cfg["utility_at_hard_limit"], "Property is far outside the buyer's target distance."

    if over_pct <= soft:
        utility = linear_interpolate(
            over_pct,
            0.0,
            1.0,
            soft,
            cfg["utility_at_soft_limit"],
        )
        return clamp(utility), "Property is slightly outside the buyer's target distance."

    utility = linear_interpolate(
        over_pct,
        soft,
        cfg["utility_at_soft_limit"],
        hard,
        cfg["utility_at_hard_limit"],
    )

    return clamp(utility), "Property is meaningfully outside the buyer's target distance."


def schools_utility(listing, preference, cfg):
    """
    Mixed utility.

    School preference can be rating-based or district-match based.
    """

    mode = normalize_key(preference.get("mode")) or "minimum_rating"

    if mode == "not_important":
        return 1.00, "Schools are marked as not important."

    if mode == "minimum_rating":
        target_rating = float(preference["value"])
        actual_rating = listing.get("school_rating")
        rating_cfg = cfg["minimum_rating_mode"]

        if actual_rating is None:
            return rating_cfg["missing_rating_utility"], "School rating is missing, so a neutral utility was used."

        if actual_rating >= target_rating:
            return 1.00, "School rating meets or exceeds the buyer's target."

        gap = int(target_rating - actual_rating)

        if gap == 1:
            return rating_cfg["one_point_below"], "School rating is one point below the buyer's target."

        if gap == 2:
            return rating_cfg["two_points_below"], "School rating is two points below the buyer's target."

        return rating_cfg["three_or_more_points_below"], "School rating is far below the buyer's target."

    if mode == "district_match":
        desired_district = normalize_key(preference["value"])
        actual_district = normalize_key(listing.get("school_district"))
        district_cfg = cfg["district_match_mode"]

        if actual_district is None:
            return district_cfg["unknown"], "School district is missing, so a neutral utility was used."

        if actual_district == desired_district:
            return district_cfg["match"], "School district matches the buyer's preference."

        return district_cfg["no_match"], "School district does not match the buyer's preference."

    return 0.50, f"Unsupported school preference mode '{preference.get('mode')}', so a neutral utility was used."
