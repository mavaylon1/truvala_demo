import argparse
import json
from pathlib import Path

from buyer_score import calculate_buyer_fit_score


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--listing",
        required=True,
        help="Path to listing JSON file.",
    )
    parser.add_argument(
        "--buyer",
        required=True,
        help="Path to buyer preferences JSON file.",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Optional path to write score result JSON.",
    )

    args = parser.parse_args()

    listing = load_json(args.listing)
    buyer_preferences = load_json(args.buyer)

    result = calculate_buyer_fit_score(
        raw_listing=listing,
        buyer_preferences=buyer_preferences,
    )

    output_text = json.dumps(result, indent=2)

    if args.output:
        Path(args.output).write_text(output_text)
    else:
        print(output_text)


def load_json(path):
    with open(path, "r") as f:
        return json.load(f)


if __name__ == "__main__":
    main()
