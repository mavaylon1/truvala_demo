from .age_era import age_era_risk
from .component_lifespan import component_lifespan_risk
from .listing_language import listing_language_red_flags
from .missing_info import missing_info_checklist
from .builder_info import builder_info_risk
from .maintenance_history import maintenance_history_risk
from .neighborhood_risk import neighborhood_risk
from .insurance_risk import insurance_risk


def analyze_risk(listing: dict) -> dict:
    age        = age_era_risk(listing)
    components = component_lifespan_risk(listing)
    language   = listing_language_red_flags(listing)
    checklist  = missing_info_checklist(age, components, language)
    builder    = builder_info_risk(listing)
    maintenance = maintenance_history_risk(listing)
    neighborhood = neighborhood_risk(listing)
    insurance    = insurance_risk(listing)

    return {
        "age_era":                age,
        "component_lifespan":     components,
        "listing_language":       language,
        "verification_checklist": checklist,
        "builder_info":           builder,
        "maintenance_history":    maintenance,
        "neighborhood":           neighborhood,
        "insurance":              insurance,
    }
