from .config import BUYER_FIT_V1_CONFIG
from .helpers import clamp, get_weight
from .normalizer import normalize_listing
from .utilities import (
    bathrooms_utility,
    bedrooms_utility,
    compatibility_matrix_utility,
    distance_utility,
    price_utility,
    schools_utility,
)


def calculate_buyer_fit_score(raw_listing, buyer_preferences, config=None):
    """
    Main public function.

    Inputs:
      raw_listing: dict from JSON listing extraction
      buyer_preferences: dict
      config: optional scoring config override

    Returns:
      dict with final score, field scores, skipped fields, and normalized listing.
    """

    if config is None:
        config = BUYER_FIT_V1_CONFIG

    listing = normalize_listing(raw_listing)
    fields_config = config["fields"]

    field_scores = {}
    skipped_fields = {}

    score_field(
        field_scores=field_scores,
        skipped_fields=skipped_fields,
        field_name="price",
        preference=buyer_preferences.get("max_price"),
        config=config,
        utility_function=lambda pref, cfg: price_utility(
            listing.get("price"),
            float(pref["value"]),
            cfg,
        ),
    )

    score_field(
        field_scores=field_scores,
        skipped_fields=skipped_fields,
        field_name="bedrooms",
        preference=buyer_preferences.get("min_bedrooms"),
        config=config,
        utility_function=lambda pref, cfg: bedrooms_utility(
            listing.get("bedrooms"),
            float(pref["value"]),
            cfg,
        ),
    )

    score_field(
        field_scores=field_scores,
        skipped_fields=skipped_fields,
        field_name="bathrooms",
        preference=buyer_preferences.get("min_bathrooms"),
        config=config,
        utility_function=lambda pref, cfg: bathrooms_utility(
            listing.get("bathrooms"),
            float(pref["value"]),
            cfg,
        ),
    )

    score_field(
        field_scores=field_scores,
        skipped_fields=skipped_fields,
        field_name="property_type",
        preference=buyer_preferences.get("property_type"),
        config=config,
        utility_function=lambda pref, cfg: compatibility_matrix_utility(
            listing.get("property_type"),
            pref["value"],
            cfg,
            "Property type",
        ),
    )

    if listing.get("distance_miles") is None:
        skipped_fields["distance"] = "No reference city set — add one in preferences to score distance."
    else:
        score_field(
            field_scores=field_scores,
            skipped_fields=skipped_fields,
            field_name="distance",
            preference=buyer_preferences.get("max_distance_miles"),
            config=config,
            utility_function=lambda pref, cfg: distance_utility(
                listing.get("distance_miles"),
                float(pref["value"]),
                cfg,
                (buyer_preferences.get("reference_city") or "").strip() or None,
            ),
        )

    score_field(
        field_scores=field_scores,
        skipped_fields=skipped_fields,
        field_name="floors",
        preference=buyer_preferences.get("floors"),
        config=config,
        utility_function=lambda pref, cfg: compatibility_matrix_utility(
            listing.get("floors"),
            pref["value"],
            cfg,
            "Floor layout",
        ),
    )

    score_field(
        field_scores=field_scores,
        skipped_fields=skipped_fields,
        field_name="schools",
        preference=buyer_preferences.get("schools"),
        config=config,
        utility_function=lambda pref, cfg: schools_utility(
            listing,
            pref,
            cfg,
        ),
    )

    buyer_fit_score = aggregate_score(field_scores)

    return {
        "buyer_fit_score": buyer_fit_score,
        "model_version": config["model_version"],
        "field_scores": field_scores,
        "skipped_fields": skipped_fields,
        "normalized_listing": listing,
    }


def score_field(
    field_scores,
    skipped_fields,
    field_name,
    preference,
    config,
    utility_function,
):
    field_config = config["fields"][field_name]

    if not field_config.get("enabled", True):
        skipped_fields[field_name] = "Field is disabled in scoring config."
        return

    if preference is None:
        skipped_fields[field_name] = "Buyer did not provide this preference."
        return

    if "value" not in preference:
        skipped_fields[field_name] = "Buyer preference is missing a value."
        return

    importance = int(preference.get("importance", 3))
    weight = get_weight(importance, config)

    utility, explanation = utility_function(preference, field_config)
    utility = clamp(float(utility))

    field_scores[field_name] = {
        "utility": round(utility, 4),
        "importance": importance,
        "weight": weight,
        "weighted_value": round(weight * utility, 4),
        "explanation": explanation,
        "utility_type": field_config.get("utility_type"),
    }


def aggregate_score(field_scores):
    if not field_scores:
        return 0

    total_weighted_value = sum(
        field_score["weighted_value"]
        for field_score in field_scores.values()
    )

    total_weight = sum(
        field_score["weight"]
        for field_score in field_scores.values()
    )

    if total_weight == 0:
        return 0

    return round(100 * total_weighted_value / total_weight)
