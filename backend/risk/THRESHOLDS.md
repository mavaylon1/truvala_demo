# Risk Scoring Thresholds

How each of the four risk categories is scored Low / Medium / High.
These are deterministic rules — no model involved.

---

## Age & Era

**Source:** `age_era.py` era bucket → signal strings passed into `computeRiskLevels()`

**Decision:**
Looks for the words `"lead paint"` or `"asbestos"` in the computed signal strings.

| Level  | Condition |
|--------|-----------|
| High   | Either phrase found — means pre-1978 construction |
| Medium | No lead/asbestos but other signals present (e.g. 1978–1989 polybutylene, EIFS flags) |
| Low    | No signals at all (2010+ homes) |

**Why this line:**
1978 is a federal regulatory threshold — the Residential Lead-Based Paint Hazard Reduction Act
requires disclosure for all pre-1978 homes. It is also the approximate end of the asbestos
construction era. Using the signal text (rather than year directly) means the threshold is
driven by the era rules in `age_era.py`, not hardcoded twice.

**Sharp boundary to be aware of:**
A 1977 home is High; a 1978 home is Medium. This is intentional. A 1978–1985 home still has
polybutylene and aging-system concerns, which correctly land it at Medium rather than Low.

---

## Components

**Source:** `component_lifespan.py` signal strings passed into `computeRiskLevels()`

**Decision:**
Counts two categories of signals:
- `pastLifespan` — signals containing `"replacement verification recommended"` (estimated age ≥ lower bound of typical lifespan)
- `approaching` — signals containing `"approaching"` (estimated age ≥ 75% of lower lifespan bound)

| Level  | Condition |
|--------|-----------|
| High   | 3 or more components past lifespan |
| Medium | 1–2 past lifespan, OR 2+ approaching lifespan |
| Low    | Nothing past lifespan, 0–1 approaching |

**Components tracked (6 total):**
Roof (20–30 yr), HVAC (15–20 yr), Water Heater (10–15 yr),
Electrical Panel (30–40 yr), Windows (20–25 yr), Plumbing (40–70 yr).

If the listing description mentions a component was updated (e.g. "new roof"), that component
is removed from the count and moved to Observed Facts. The age estimate is based on
`current_year − year_built`, which is a worst-case assumption when no update is mentioned.

**Known behavior:**
On a very old home (1965, no updates mentioned), all 6 components will be past lifespan → High.
On a 2000-built home at 25 years, only the water heater and possibly HVAC are flagged → Medium.

---

## Listing Flags

**Source:** `listing_language.py` matched signals, each pre-tagged with `[High]`, `[Medium]`, or `[Low]`

**Decision:**
Takes the highest severity tag found across all matched signals. One High-severity match
overrides everything else.

| Level  | Condition |
|--------|-----------|
| High   | Any `[High]` flag present |
| Medium | No High flags, but any `[Medium]` flag present |
| Low    | Only `[Low]` flags, or no flags at all |

**High-severity flags (any one → High):**
as-is sale, cash only, unpermitted work, flood zone, mold/water damage, short sale

**Medium-severity flags:**
buyer to verify, tenant occupied, probate/estate sale

**Low-severity flags:**
price reduced, motivated seller

**To adjust severity of a specific phrase:**
Change its `"severity"` field in `listing_language.py`. The threshold logic here will
automatically pick up the change.

---

## Verify Gaps

**Source:** `missing_info.py` checklist items filtered to `priority == "High"`

**Decision:**
Counts the number of High-priority unconfirmed items in the verification checklist.

| Level  | Condition |
|--------|-----------|
| High   | 5 or more High-priority items |
| Medium | 2–4 High-priority items |
| Low    | 0–1 High-priority items |

**High-priority items include:**
Roof age, HVAC age, electrical panel history, plumbing material, permit history,
environmental assessment (lead/asbestos), foundation inspection, wiring type.

**Known behavior:**
A 1965 home with no listing description will generate ~7 High-priority gaps from age and era
rules alone, landing it at High. The threshold of 5 for High may warrant raising to 6–7 if
this fires too easily in practice. Adjust the thresholds in `computeRiskLevels()` in
`extension/content.js`.

---

## Adjusting thresholds

All four thresholds live in `computeRiskLevels()` in `extension/content.js`.
The signal text that triggers each rule comes from the backend modules:

| Category       | Rules defined in               |
|----------------|-------------------------------|
| Age & Era      | `backend/risk/age_era.py`     |
| Components     | `backend/risk/component_lifespan.py` |
| Listing Flags  | `backend/risk/listing_language.py`   |
| Verify Gaps    | `backend/risk/missing_info.py`       |

Priority labels (High / Medium / Low) on checklist items are set in `missing_info.py`
in `_COST_TABLE`. Severity tags on listing flags are set per-flag in `listing_language.py`.
