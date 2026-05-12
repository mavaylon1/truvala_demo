def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def normalize_key(value):
    if value is None:
        return None

    normalized = str(value).strip().lower()
    normalized = normalized.replace("&", "and")
    normalized = normalized.replace("/", " ")
    normalized = normalized.replace("-", " ")
    normalized = "_".join(normalized.split())

    aliases = {
        "single_family_home": "single_family",
        "single_family_residence": "single_family",
        "sfh": "single_family",
        "townhome": "townhouse",
        "manufactured": "manufactured_home",
        "manufactured_home_in_park": "manufactured_in_park",
        "manufactured_in_a_park": "manufactured_in_park",
        "mobile_home": "manufactured_home",
        "mobile_home_in_park": "manufactured_in_park",
        "one_story": "single_story",
        "1_story": "single_story",
        "single_level": "single_story",
        "two_level": "two_story",
        "2_story": "two_story",
        "three_story": "three_plus_story",
        "3_story": "three_plus_story",
    }

    return aliases.get(normalized, normalized)


def linear_interpolate(x, x0, y0, x1, y1):
    if x1 == x0:
        return y1

    t = (x - x0) / (x1 - x0)
    return y0 + t * (y1 - y0)


def get_weight(importance, config):
    weights = config["importance_weights"]
    key = str(int(importance))

    if key not in weights:
        raise ValueError(f"Importance must be 1-5. Got: {importance}")

    return float(weights[key])


def get_nested(dictionary, path, default=None):
    current = dictionary

    for key in path:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]

    return current
