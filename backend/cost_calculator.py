"""
Monthly cost estimator for a given listing.

Uses state-level averages for property tax and utilities.
Mortgage assumes 20% down, 30-year fixed at current rate.
"""

# State-level effective property tax rates (annual % of assessed value)
STATE_TAX_RATES = {
    'AL': 0.0040, 'AK': 0.0100, 'AZ': 0.0063, 'AR': 0.0062, 'CA': 0.0077,
    'CO': 0.0049, 'CT': 0.0173, 'DE': 0.0056, 'FL': 0.0083, 'GA': 0.0094,
    'HI': 0.0028, 'ID': 0.0063, 'IL': 0.0198, 'IN': 0.0085, 'IA': 0.0151,
    'KS': 0.0132, 'KY': 0.0086, 'LA': 0.0055, 'ME': 0.0109, 'MD': 0.0099,
    'MA': 0.0104, 'MI': 0.0138, 'MN': 0.0111, 'MS': 0.0063, 'MO': 0.0097,
    'MT': 0.0074, 'NE': 0.0153, 'NV': 0.0060, 'NH': 0.0186, 'NJ': 0.0219,
    'NM': 0.0055, 'NY': 0.0172, 'NC': 0.0077, 'ND': 0.0098, 'OH': 0.0152,
    'OK': 0.0090, 'OR': 0.0090, 'PA': 0.0153, 'RI': 0.0135, 'SC': 0.0057,
    'SD': 0.0114, 'TN': 0.0056, 'TX': 0.0168, 'UT': 0.0058, 'VT': 0.0178,
    'VA': 0.0082, 'WA': 0.0093, 'WV': 0.0059, 'WI': 0.0157, 'WY': 0.0061,
}
DEFAULT_TAX_RATE = 0.0107  # national average

# Average monthly utilities (electricity + gas + water) by state
STATE_UTILITY_AVG = {
    'AL': 195, 'AK': 225, 'AZ': 195, 'AR': 175, 'CA': 185,
    'CO': 165, 'CT': 215, 'DE': 185, 'FL': 195, 'GA': 190,
    'HI': 220, 'ID': 155, 'IL': 185, 'IN': 180, 'IA': 175,
    'KS': 175, 'KY': 175, 'LA': 195, 'ME': 200, 'MD': 185,
    'MA': 215, 'MI': 190, 'MN': 185, 'MS': 190, 'MO': 175,
    'MT': 160, 'NE': 175, 'NV': 185, 'NH': 210, 'NJ': 205,
    'NM': 165, 'NY': 210, 'NC': 175, 'ND': 175, 'OH': 175,
    'OK': 175, 'OR': 150, 'PA': 185, 'RI': 210, 'SC': 180,
    'SD': 170, 'TN': 180, 'TX': 210, 'UT': 165, 'VT': 195,
    'VA': 175, 'WA': 145, 'WV': 175, 'WI': 180, 'WY': 160,
}
DEFAULT_UTILITY = 175

INTEREST_RATE   = 0.0699  # 30-year fixed rate (update periodically)
DOWN_PAYMENT    = 0.20
LOAN_TERM_YEARS = 30


def calculate_monthly_costs(structured: dict) -> dict | None:
    price = structured.get('price')
    if not price:
        return None

    state       = (structured.get('state') or '').upper().strip()
    sqft        = structured.get('sqft')
    hoa_raw     = structured.get('hoa_fee_monthly')
    land_lease  = structured.get('land_lease_monthly') or 0

    mortgage    = _mortgage(price)
    prop_tax    = _property_tax(price, state)
    utilities   = _utilities(state, sqft)
    hoa         = int(hoa_raw) if hoa_raw is not None else 0
    hoa_note    = None if hoa_raw is not None else "HOA not found in listing — verify with your agent"

    # Land lease is its own line if present (manufactured homes, etc.)
    land_lease_note = "Land lease included" if land_lease else None

    total = mortgage + prop_tax + hoa + utilities + land_lease

    return {
        'mortgage':     mortgage,
        'property_tax': prop_tax,
        'hoa':          hoa,
        'hoa_note':     hoa_note,
        'land_lease':   land_lease,
        'land_lease_note': land_lease_note,
        'utilities':    utilities,
        'total':        total,
        'assumptions': {
            'down_payment_pct': DOWN_PAYMENT,
            'interest_rate':    INTEREST_RATE,
            'term_years':       LOAN_TERM_YEARS,
        },
    }


def _mortgage(price: float) -> int:
    principal = price * (1 - DOWN_PAYMENT)
    r = INTEREST_RATE / 12
    n = LOAN_TERM_YEARS * 12
    payment = principal * r * (1 + r) ** n / ((1 + r) ** n - 1)
    return round(payment)


def _property_tax(price: float, state: str) -> int:
    rate = STATE_TAX_RATES.get(state, DEFAULT_TAX_RATE)
    return round(price * rate / 12)


def _utilities(state: str, sqft: float | None) -> int:
    base = STATE_UTILITY_AVG.get(state, DEFAULT_UTILITY)
    if sqft:
        if sqft < 1000:   factor = 0.80
        elif sqft < 2000: factor = 1.00
        elif sqft < 3000: factor = 1.25
        else:             factor = 1.50
        base = round(base * factor)
    return base
