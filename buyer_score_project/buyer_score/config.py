BUYER_FIT_V1_CONFIG = {
    "model_version": "buyer_fit_v1",

    # User-facing importance is 1-5.
    # Backend weights are tunable and intentionally nonlinear.
    "importance_weights": {
        "1": 0.25,
        "2": 0.75,
        "3": 1.5,
        "4": 3.0,
        "5": 6.0,
    },

    "fields": {
        "price": {
            "enabled": True,
            "utility_type": "curve",
            "soft_over_budget_pct": 0.05,
            "hard_over_budget_pct": 0.15,
            "utility_at_soft_limit": 0.80,
            "utility_at_hard_limit": 0.00,
            "missing_utility": 0.50,
        },

        "bedrooms": {
            "enabled": True,
            "utility_type": "step",
            "utilities_by_missing_count": {
                "0": 1.00,
                "1": 0.65,
                "2": 0.30,
                "3+": 0.00,
            },
            "missing_utility": 0.50,
        },

        "bathrooms": {
            "enabled": True,
            "utility_type": "penalty",
            "missing_full_bath_penalty": 0.35,
            "missing_half_bath_penalty": 0.15,
            "minimum_utility": 0.00,
            "missing_utility": 0.50,
        },

        "property_type": {
            "enabled": True,
            "utility_type": "compatibility_matrix",
            "default_unknown_utility": 0.50,
            "compatibility_matrix": {
                "single_family": {
                    "single_family": 1.00,
                    "townhouse": 0.70,
                    "condo": 0.45,
                    "manufactured_home": 0.20,
                    "manufactured_in_park": 0.15,
                    "land": 0.05,
                    "unknown": 0.50,
                },
                "townhouse": {
                    "single_family": 0.85,
                    "townhouse": 1.00,
                    "condo": 0.70,
                    "manufactured_home": 0.25,
                    "manufactured_in_park": 0.20,
                    "land": 0.05,
                    "unknown": 0.50,
                },
                "condo": {
                    "single_family": 0.70,
                    "townhouse": 0.85,
                    "condo": 1.00,
                    "manufactured_home": 0.25,
                    "manufactured_in_park": 0.20,
                    "land": 0.05,
                    "unknown": 0.50,
                },
                "manufactured_home": {
                    "single_family": 0.55,
                    "townhouse": 0.45,
                    "condo": 0.40,
                    "manufactured_home": 1.00,
                    "manufactured_in_park": 0.85,
                    "land": 0.05,
                    "unknown": 0.50,
                },
                "land": {
                    "single_family": 0.10,
                    "townhouse": 0.05,
                    "condo": 0.05,
                    "manufactured_home": 0.05,
                    "manufactured_in_park": 0.05,
                    "land": 1.00,
                    "unknown": 0.50,
                },
            },
        },

        "distance": {
            "enabled": True,
            "utility_type": "curve",
            "soft_over_target_pct": 0.25,
            "hard_over_target_pct": 1.00,
            "utility_at_soft_limit": 0.80,
            "utility_at_hard_limit": 0.00,
            "missing_utility": 0.50,
        },

        "floors": {
            "enabled": True,
            "utility_type": "compatibility_matrix",
            "default_unknown_utility": 0.50,
            "compatibility_matrix": {
                "single_story": {
                    "single_story": 1.00,
                    "two_story": 0.30,
                    "three_plus_story": 0.10,
                    "unknown": 0.50,
                },
                "two_story": {
                    "single_story": 0.65,
                    "two_story": 1.00,
                    "three_plus_story": 0.60,
                    "unknown": 0.50,
                },
                "three_plus_story": {
                    "single_story": 0.30,
                    "two_story": 0.65,
                    "three_plus_story": 1.00,
                    "unknown": 0.50,
                },
                "any": {
                    "single_story": 1.00,
                    "two_story": 1.00,
                    "three_plus_story": 1.00,
                    "unknown": 1.00,
                },
                # Legacy keys — kept so existing saved preferences don't break
                "single_story_required": {
                    "single_story": 1.00,
                    "two_story": 0.10,
                    "three_plus_story": 0.00,
                    "unknown": 0.50,
                },
                "single_story_preferred": {
                    "single_story": 1.00,
                    "two_story": 0.65,
                    "three_plus_story": 0.35,
                    "unknown": 0.60,
                },
            },
        },

        "schools": {
            "enabled": True,
            "utility_type": "mixed",
            "minimum_rating_mode": {
                "missing_rating_utility": 0.50,
                "one_point_below": 0.75,
                "two_points_below": 0.50,
                "three_or_more_points_below": 0.00,
            },
            "district_match_mode": {
                "match": 1.00,
                "no_match": 0.00,
                "unknown": 0.50,
            },
        },
    },
}
