from .age_era import age_era_risk
from .component_lifespan import component_lifespan_risk
from .listing_language import listing_language_red_flags
from .missing_info import missing_info_checklist


def analyze_risk(listing: dict) -> dict:
    age = age_era_risk(listing)
    components = component_lifespan_risk(listing)
    language = listing_language_red_flags(listing)
    checklist = missing_info_checklist(age, components, language)

    return {
        "age_era": age,
        "component_lifespan": components,
        "listing_language": language,
        "verification_checklist": checklist,
    }
