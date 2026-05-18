"""CLI entrypoint for the real estate scraper.

Usage:
    python scrape.py <URL> [<URL> ...] [--out-dir results] [--headed]
        [--site auto|zillow|realtor|redfin|trulia]
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path
from typing import List
from urllib.parse import urlparse

from scrapers import (
    BaseScraper,
    Listing,
    RealtorScraper,
    RedfinScraper,
    TruliaScraper,
    ZillowScraper,
)


SITE_MAP = {
    "zillow": ZillowScraper,
    "realtor": RealtorScraper,
    "redfin": RedfinScraper,
    "trulia": TruliaScraper,
}


def detect_site(url: str) -> str:
    host = urlparse(url).netloc.lower()
    if "zillow.com" in host:
        return "zillow"
    if "realtor.com" in host:
        return "realtor"
    if "redfin.com" in host:
        return "redfin"
    if "trulia.com" in host:
        return "trulia"
    raise ValueError(f"Cannot detect site from URL: {url}")


def _format_schools_cell(schools):
    """Render a list of school dicts as a single CSV cell."""
    bits = []
    for s in schools:
        name = s.get("name") or ""
        rating = s.get("rating")
        scale = s.get("rating_scale") or "10"
        dist = s.get("distance_mi")
        level = s.get("level")
        grades = s.get("grades")
        label = name
        if rating:
            label += " (" + str(rating) + "/" + str(scale) + ")"
        meta = []
        if level:
            meta.append(level)
        elif grades:
            meta.append("grades " + str(grades))
        if dist is not None:
            meta.append(str(dist) + " mi")
        if meta:
            label += " - " + ", ".join(meta)
        bits.append(label)
    return "; ".join(bits)


def _avg_school_rating(schools):
    nums = []
    for s in schools:
        try:
            nums.append(float(s.get("rating")))
        except (TypeError, ValueError):
            continue
    if not nums:
        return ""
    return "%.1f" % (sum(nums) / len(nums))


def write_outputs(listings, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "results.json"
    csv_path = out_dir / "results.csv"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump([l.to_dict() for l in listings], f, indent=2, ensure_ascii=False)

    fieldnames = [
        "source", "listing_id", "url", "address", "price",
        "beds", "baths", "sqft", "lot_size", "year_built",
        "property_type", "latitude", "longitude", "description",
        "schools", "schools_avg_rating", "photos",
    ]
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for l in listings:
            row = l.to_dict()
            row["photos"] = "; ".join(row.get("photos") or [])
            row["schools"] = _format_schools_cell(row.get("schools") or [])
            row["schools_avg_rating"] = _avg_school_rating(row.get("schools") or [])
            row.pop("raw", None)
            writer.writerow({k: row.get(k) for k in fieldnames})

    print("Wrote %d listings:" % len(listings))
    print("  " + str(json_path))
    print("  " + str(csv_path))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Selenium scraper for Zillow, Realtor.com, Redfin, and Trulia."
    )
    parser.add_argument("urls", nargs="+", help="Search-result or listing-detail URLs")
    parser.add_argument("--out-dir", default="results",
                        help="Where to write results.csv / results.json")
    parser.add_argument("--headed", action="store_true",
                        help="Show the browser window (default: headless)")
    parser.add_argument("--proxy", default=None,
                        help="Optional upstream proxy URL")
    parser.add_argument(
        "--site",
        choices=["auto", "zillow", "realtor", "redfin", "trulia"],
        default="auto",
        help="Force a particular site scraper instead of auto-detecting",
    )
    parser.add_argument("--stealth", action="store_true",
                        help="Use undetected-chromedriver "
                             "(required for Zillow/Trulia past "
                             "PerimeterX). Install with "
                             "`pip install undetected-chromedriver`.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    grouped = {}
    for url in args.urls:
        site = args.site if args.site != "auto" else detect_site(url)
        grouped.setdefault(site, []).append(url)

    all_listings = []
    for site, urls in grouped.items():
        ScraperCls = SITE_MAP[site]
        with ScraperCls(headless=not args.headed,
                        proxy=args.proxy,
                        stealth=args.stealth) as scraper:
            for url in urls:
                try:
                    listings = scraper.scrape(url)
                    logging.info("Got %d listings from %s", len(listings), url)
                    all_listings.extend(listings)
                except Exception as e:
                    logging.exception("Failed to scrape %s: %s", url, e)

    write_outputs(all_listings, Path(args.out_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())