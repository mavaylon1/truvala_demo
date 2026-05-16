"""
EcoSolar USA partner integration.
https://ecosolarusa.com

─── How to connect the real EcoSolar API ────────────────────────────────────────
1. Replace the body of get_ecosolar_estimate() with an actual HTTP call to
   EcoSolar's cost calculator endpoint.
2. Map their response fields to the return dict shape below — the frontend
   depends on that shape and won't need changes.
3. Store the API key in ~/.env as ECOSOLAR_API_KEY and load it with dotenv.

Example real call (once endpoint is known):

    import requests, os
    response = requests.post(
        'https://api.ecosolarusa.com/v1/estimate',
        headers={'Authorization': f"Bearer {os.environ['ECOSOLAR_API_KEY']}"},
        json={'zip_code': zip_code, 'sqft': sqft, 'monthly_utility': monthly_utility},
        timeout=10,
    )
    data = response.json()
    return {
        'logo_url':               ECOSOLAR_LOGO,
        'system_size_kw':         data['system_kw'],
        'system_total_cost':      data['total_cost'],
        'panel_monthly_payment':  data['monthly_payment'],
        'monthly_electric_savings': data['monthly_savings'],
        'net_monthly_impact':     data['monthly_payment'] - data['monthly_savings'],
        'estimated_payoff_years': data['payoff_years'],
        'note':                   data.get('note', NOTE),
    }
─────────────────────────────────────────────────────────────────────────────────
"""

ECOSOLAR_LOGO = 'https://ecosolarusa.com/wp-content/uploads/2023/06/EcoSolar-USA-logo-border.png'

NOTE = (
    'Estimates based on regional solar averages for this zip code. '
    'Contact EcoSolar USA for a precise, no-obligation quote.'
)

# ─── Industry-average constants (replaced by real API when connected) ─────────
COST_PER_KW       = 2900   # installed $/kW (post-ITC incentive average)
FINANCE_RATE      = 0.0499  # 4.99% APR solar loan
FINANCE_YEARS     = 20
SOLAR_OFFSET      = 0.78   # % of electricity offset by solar (sunny-state avg)
AVG_ELECTRIC_RATE = 0.16   # $/kWh (national avg; CA is ~0.26, TX ~0.12)
KW_PER_SQFT       = 0.003  # rough system sizing rule


def get_ecosolar_estimate(zip_code: str, sqft: float | None, monthly_utility: float) -> dict:
    """
    Returns EcoSolar cost and savings breakdown.
    Swap this body for a real API call when the integration is ready.
    """
    sqft = sqft or 1500

    system_kw       = max(3.0, round(sqft * KW_PER_SQFT, 1))
    system_cost     = round(system_kw * COST_PER_KW)
    monthly_payment = _loan_payment(system_cost, FINANCE_RATE, FINANCE_YEARS)

    # Savings: offset % of utility bill (capped at actual bill)
    monthly_savings = round(min(monthly_utility * SOLAR_OFFSET, monthly_utility))
    net_impact      = monthly_payment - monthly_savings
    payoff_years    = round(system_cost / (monthly_savings * 12), 1) if monthly_savings > 0 else None

    return {
        'logo_url':               ECOSOLAR_LOGO,
        'system_size_kw':         system_kw,
        'system_total_cost':      system_cost,
        'panel_monthly_payment':  monthly_payment,
        'monthly_electric_savings': monthly_savings,
        'net_monthly_impact':     round(net_impact),
        'estimated_payoff_years': payoff_years,
        'note':                   NOTE,
    }


def _loan_payment(principal: float, annual_rate: float, years: int) -> int:
    r = annual_rate / 12
    n = years * 12
    return round(principal * r * (1 + r) ** n / ((1 + r) ** n - 1))
