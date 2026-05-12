# Buyer Fit Score Calculator

This is a config-driven Buyer Fit Score calculator.

The important design choice:

- The code defines how each field is scored.
- The config defines how strict each field should be.
- Listing input is plain JSON.
- Buyer preferences are plain JSON.
- Output is explainable JSON.

## Folder Structure

```text
buyer_score_project/
  buyer_score/
    __init__.py
    calculator.py
    config.py
    helpers.py
    normalizer.py
    utilities.py
  run_buyer_score.py
  listing_94_yorktown.json
  buyer_preferences_example.json
```

## Run

```bash
python run_buyer_score.py \
  --listing listing_94_yorktown.json \
  --buyer buyer_preferences_example.json
```

Or write output to a file:

```bash
python run_buyer_score.py \
  --listing listing_94_yorktown.json \
  --buyer buyer_preferences_example.json \
  --output result.json
```

## Buyer Preference Format

```json
{
  "max_price": {
    "value": 500000,
    "importance": 5
  },
  "min_bedrooms": {
    "value": 2,
    "importance": 4
  },
  "property_type": {
    "value": "single_family",
    "importance": 4
  }
}
```

Importance is 1-5.

The backend maps importance to tunable weights in `buyer_score/config.py`.

## Utility Function Types

- Price: curve function
- Bedrooms: step utility
- Bathrooms: penalty function
- Property type: compatibility matrix
- Distance: curve function
- Floors: compatibility matrix
- Schools: mixed utility

## Tuning

Tune scoring behavior in:

```text
buyer_score/config.py
```

Example:

```python
"importance_weights": {
    "1": 0.25,
    "2": 0.75,
    "3": 1.5,
    "4": 3.0,
    "5": 6.0,
}
```

The goal is to avoid editing calculator code when adjusting score behavior.
