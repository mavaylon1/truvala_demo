"""Trulia scraper.

Trulia is owned by Zillow Group; their listing detail pages embed an Apollo
GraphQL cache inside `__NEXT_DATA__` at
`props.pageProps.__APOLLO_STATE__`. We walk the Apollo cache, find the home
record (key starts with `FullHomeDetails:` or `HOME:`), and pull fields off it.

Supports:
  - Search results, e.g.
      https://www.trulia.com/TX/Austin/
      https://www.trulia.com/for_sale/Austin,TX/
  - Detail pages, e.g.
      https://www.trulia.com/p/tx/austin/123-main-st-austin-tx-78701--2099012345
"""
from __future__ import annotations

import json
import logging
import re
from typing import List, Optional

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

from .base import BaseScraper, Listing, human_pause, normalize_school, scroll_to_bottom, safe_text

log = logging.getLogger(__name__)


class TruliaScraper(BaseScraper):
    SOURCE = "trulia"

    DETAIL_URL_RE = re.compile(r"/p/|/home/\d+", re.I)

    def scrape(self, url: str) -> List[Listing]:
        self.get(url)
        if self.check_blocked():
            log.warning("Trulia blocked the request; returning empty list.")
            return []

        if self.DETAIL_URL_RE.search(url):
            d = self._scrape_detail(url)
            return [d] if d else []
        return self._scrape_search(url)

    # ------------------------------------------------------------------ search

    def _scrape_search(self, url: str) -> List[Listing]:
        scroll_to_bottom(self.driver, step_px=900, max_steps=25)

        results: List[Listing] = []
        seen = set()

        # Trulia card anchors have data-testid="property-card-link" on newer builds.
        anchors = self.driver.find_elements(By.CSS_SELECTOR, "a[data-testid='property-card-link']")
        if not anchors:
            anchors = self.driver.find_elements(By.CSS_SELECTOR, "a[href*='/p/'], a[href*='/home/']")

        log.info("Trulia: found %d card anchors", len(anchors))
        for a in anchors:
            href = a.get_attribute("href")
            if not href or href in seen:
                continue
            if "/p/" not in href and "/home/" not in href:
                continue
            seen.add(href)

            # Best-effort quick fields from the surrounding card.
            try:
                card = a.find_element(By.XPATH, "./ancestor::div[contains(@data-testid,'property-card')][1]")
            except Exception:
                card = a
            quick = Listing(
                source=self.SOURCE,
                url=href,
                price=safe_text(card, By.CSS_SELECTOR, "[data-testid='property-price']"),
                address=safe_text(card, By.CSS_SELECTOR, "[data-testid='property-address']"),
                beds=safe_text(card, By.CSS_SELECTOR, "[data-testid='property-beds']"),
                baths=safe_text(card, By.CSS_SELECTOR, "[data-testid='property-baths']"),
                sqft=safe_text(card, By.CSS_SELECTOR, "[data-testid='property-floorSpace']"),
            )
            results.append(quick)

        enriched: List[Listing] = []
        for r in results:
            try:
                self.get(r.url)
                d = self._scrape_detail(r.url)
                if d:
                    d.price = d.price or r.price
                    d.address = d.address or r.address
                    d.beds = d.beds or r.beds
                    d.baths = d.baths or r.baths
                    d.sqft = d.sqft or r.sqft
                    enriched.append(d)
                else:
                    enriched.append(r)
                human_pause(2.0, 4.5)
            except Exception as e:
                log.warning("Trulia: failed to enrich %s: %s", r.url, e)
                enriched.append(r)
        return enriched

    # ------------------------------------------------------------------ detail

    def _scrape_detail(self, url: str) -> Optional[Listing]:
        try:
            self.wait().until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        except Exception:
            pass
        scroll_to_bottom(self.driver, step_px=600, max_steps=12)

        listing = Listing(source=self.SOURCE, url=self.driver.current_url)
        blob = self._extract_next_data()
        if blob:
            try:
                page_props = blob.get("props", {}).get("pageProps", {})
                apollo = page_props.get("__APOLLO_STATE__") or page_props.get("apolloState") or {}
                home = self._find_home_record(apollo)
                if home:
                    self._fill_from_home(listing, home, apollo)
            except Exception as e:
                log.debug("Trulia detail blob parse failed: %s", e)

        # DOM fallbacks.
        if not listing.price:
            listing.price = safe_text(self.driver, By.CSS_SELECTOR, "[data-testid='home-details-summary-price']")
        if not listing.address:
            listing.address = safe_text(self.driver, By.CSS_SELECTOR, "[data-testid='home-details-summary-headline']") \
                              or safe_text(self.driver, By.CSS_SELECTOR, "h1")
        if not listing.description:
            listing.description = safe_text(
                self.driver, By.CSS_SELECTOR, "[data-testid='home-description-text-description-text']"
            )
        if not listing.photos:
            listing.photos = self._collect_photos()

        return listing

    # ------------------------------------------------------------------ helpers

    def _extract_next_data(self) -> Optional[dict]:
        try:
            el = self.driver.find_element(By.ID, "__NEXT_DATA__")
            return json.loads(el.get_attribute("innerHTML"))
        except Exception:
            return None

    @staticmethod
    def _find_home_record(apollo: dict) -> Optional[dict]:
        """Apollo cache is a flat dict keyed by `<TypeName>:<id>`.
        The big home record lives under "FullHomeDetails:..." or
        "HOME_FOR_SALE:..." depending on listing type.
        """
        candidates = []
        for k, v in apollo.items():
            if not isinstance(v, dict):
                continue
            if k.startswith(("FullHomeDetails:", "HOME:", "HOME_FOR_SALE:", "HOME_FOR_RENT:")):
                candidates.append(v)
        # Prefer the one with the most fields.
        if not candidates:
            return None
        return max(candidates, key=lambda d: len(d))

    def _fill_from_home(self, listing: Listing, home: dict, apollo: dict) -> None:
        listing.listing_id = self._strify(home.get("legacyId") or home.get("nationalId") or home.get("id"))

        price = self._deref(home.get("price"), apollo) or {}
        listing.price = self._fmt_price(price.get("price") or price.get("formattedPrice"))

        location = self._deref(home.get("location"), apollo) or {}
        addr_parts = [
            location.get("streetAddress"),
            location.get("city"),
            location.get("stateCode") or location.get("state"),
            location.get("zipCode") or location.get("zipcode"),
        ]
        listing.address = ", ".join(p for p in addr_parts if p) or None
        listing.latitude = location.get("latitude")
        listing.longitude = location.get("longitude")

        bedrooms = self._deref(home.get("bedrooms"), apollo) or {}
        bathrooms = self._deref(home.get("bathrooms"), apollo) or {}
        floor = self._deref(home.get("floorSpace"), apollo) or {}
        listing.beds = self._strify(bedrooms.get("formattedValue") or bedrooms.get("value"))
        listing.baths = self._strify(bathrooms.get("formattedValue") or bathrooms.get("value"))
        listing.sqft = self._strify(floor.get("formattedDimension") or floor.get("value"))

        details = self._deref(home.get("details"), apollo) or {}
        listing.year_built = self._strify(details.get("yearBuilt"))
        listing.lot_size = self._strify(details.get("lotSize"))
        listing.property_type = home.get("homeType") or details.get("propertyType")

        desc = self._deref(home.get("description"), apollo) or {}
        listing.description = desc.get("value") if isinstance(desc, dict) else (desc if isinstance(desc, str) else None)

        # Photos
        photos = []
        media_refs = home.get("media") or []
        if isinstance(media_refs, list):
            for m in media_refs:
                d = self._deref(m, apollo) or {}
                url = d.get("url") or d.get("imageUrl") or (d.get("image") or {}).get("url")
                if url:
                    photos.append(url)
        listing.photos = photos[:40]

        # Schools — Trulia stores them on the home as `assignedSchools` and
        # `nearbySchools`, each a list of refs into the Apollo cache.
        schools = []
        for key in ("assignedSchools", "nearbySchools"):
            for ref in (home.get(key) or []):
                d = self._deref(ref, apollo) or {}
                if d:
                    schools.append(d)
        listing.schools = self._parse_schools(schools)

        listing.raw = {
            "trackingPageEvent": home.get("trackingPageEvent"),
            "priceChange": home.get("priceChange"),
            "daysOnMarket": home.get("daysOnMarket"),
        }

    @staticmethod
    def _parse_schools(raw_schools: list) -> list:
        """Trulia school records (resolved from Apollo refs) look like:
            {"name": "...", "rating": 8, "distanceInMiles": 0.4,
             "grades": "K-5", "type": "Public", "level": "Elementary"}
        """
        out = []
        for s in raw_schools or []:
            if not isinstance(s, dict):
                continue
            norm = normalize_school(
                name=s.get("name"),
                rating=s.get("rating") or s.get("greatSchoolsRating"),
                rating_scale="10",
                distance_mi=s.get("distanceInMiles") or s.get("distance"),
                grades=s.get("grades") or s.get("gradesRange"),
                school_type=s.get("type") or s.get("schoolType"),
                level=s.get("level") or s.get("schoolLevel"),
                url=s.get("url"),
            )
            if norm:
                out.append(norm)
        return out

    # --- generic helpers --------------------------------------------------

    @staticmethod
    def _deref(ref, apollo: dict):
        """Apollo references look like {"__ref": "TypeName:id"}.
        Return the referenced dict (recursively), or the value itself if it
        isn't a ref."""
        if isinstance(ref, dict) and "__ref" in ref:
            return apollo.get(ref["__ref"]) or {}
        return ref

    @staticmethod
    def _strify(v) -> Optional[str]:
        return str(v) if v not in (None, "") else None

    @staticmethod
    def _fmt_price(p) -> Optional[str]:
        if p is None:
            return None
        try:
            return f"${int(p):,}"
        except (TypeError, ValueError):
            return str(p)

    def _collect_photos(self) -> List[str]:
        urls = []
        for img in self.driver.find_elements(By.CSS_SELECTOR, "img"):
            src = img.get_attribute("src") or ""
            if "trulia-static.com" in src or "ssl.cdn-redfin.com" in src or "photos.zillowstatic.com" in src:
                if src not in urls:
                    urls.append(src)
        return urls[:25]
