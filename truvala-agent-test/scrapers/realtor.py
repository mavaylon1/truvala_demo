"""Realtor.com scraper.

Realtor.com (Move, Inc.) ships listing data inside a __NEXT_DATA__ JSON blob,
similar to Zillow. We try the blob first, then fall back to DOM scraping.
"""
from __future__ import annotations

import json
import logging
import re
from typing import List, Optional

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

from .base import (
    BaseScraper,
    Listing,
    human_pause,
    normalize_school,
    scroll_to_bottom,
    safe_text,
)

log = logging.getLogger(__name__)


class RealtorScraper(BaseScraper):
    SOURCE = "realtor"

    DETAIL_URL_RE = re.compile(r"/realestateandhomes-detail/", re.I)

    def scrape(self, url):
        self.get(url)
        if self.check_blocked(("/distil_", "incapsula")):
            log.warning("Realtor.com blocked the request; returning empty list.")
            return []
        if self.DETAIL_URL_RE.search(url):
            d = self._scrape_detail(url)
            return [d] if d else []
        return self._scrape_search(url)

    def _scrape_search(self, url):
        scroll_to_bottom(self.driver, step_px=800, max_steps=25)

        blob = self._extract_next_data()
        results = []

        if blob:
            try:
                page_props = blob.get("props", {}).get("pageProps", {})
                candidates = (
                    page_props.get("properties"),
                    page_props.get("searchResults", {})
                              .get("home_search", {})
                              .get("results"),
                    page_props.get("initialReduxState", {})
                              .get("searchResults", {})
                              .get("listings"),
                )
                items = next((c for c in candidates if c), [])
                for item in items:
                    listing = self._listing_from_search_item(item)
                    if listing:
                        results.append(listing)
            except Exception as e:
                log.debug("Realtor: blob parse failed: %s", e)

        if not results:
            cards = self.driver.find_elements(
                By.CSS_SELECTOR, "div[data-testid='card-content']"
            )
            for card in cards:
                try:
                    a = card.find_element(By.CSS_SELECTOR, "a")
                    href = a.get_attribute("href")
                except Exception:
                    continue
                listing = Listing(
                    source=self.SOURCE,
                    url=href,
                    price=safe_text(card, By.CSS_SELECTOR,
                                    "[data-testid='card-price']"),
                    address=safe_text(card, By.CSS_SELECTOR,
                                      "[data-testid='card-address']"),
                )
                results.append(listing)

        enriched = []
        for r in results:
            try:
                self.get(r.url)
                d = self._scrape_detail(r.url)
                if d:
                    d.price = d.price or r.price
                    d.address = d.address or r.address
                    enriched.append(d)
                else:
                    enriched.append(r)
                human_pause(2.0, 4.5)
            except Exception as e:
                log.warning("Realtor: failed to enrich %s: %s", r.url, e)
                enriched.append(r)
        return enriched

    def _listing_from_search_item(self, item):
        if not isinstance(item, dict):
            return None
        href = (item.get("href") or item.get("rdc_web_url")
                or item.get("permalink"))
        if href and not href.startswith("http"):
            href = "https://www.realtor.com" + href
        if not href:
            return None

        if item.get("location"):
            addr = item.get("location", {}).get("address", {})
        else:
            addr = item.get("address", {})
        desc = item.get("description", {}) or {}

        return Listing(
            source=self.SOURCE,
            url=href,
            listing_id=(str(item.get("property_id")
                            or item.get("listing_id") or "") or None),
            price=self._fmt_price(item.get("list_price")),
            address=self._fmt_address(addr),
            beds=(str(desc.get("beds"))
                  if desc.get("beds") is not None else None),
            baths=(str(desc.get("baths"))
                   if desc.get("baths") is not None else None),
            sqft=(str(desc.get("sqft")) if desc.get("sqft") else None),
            lot_size=(str(desc.get("lot_sqft"))
                      if desc.get("lot_sqft") else None),
            year_built=(str(desc.get("year_built"))
                        if desc.get("year_built") else None),
            property_type=desc.get("type"),
        )

    def _scrape_detail(self, url):
        try:
            self.wait().until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        except Exception:
            pass
        scroll_to_bottom(self.driver, step_px=600, max_steps=10)

        blob = self._extract_next_data()
        listing = Listing(source=self.SOURCE, url=self.driver.current_url)

        if blob:
            try:
                page_props = blob.get("props", {}).get("pageProps", {})
                prop = (
                    page_props.get("property")
                    or page_props.get("initialReduxState", {})
                                 .get("propertyDetails", {})
                                 .get("data")
                    or {}
                )
                if prop:
                    self._fill_from_property(listing, prop)
            except Exception as e:
                log.debug("Realtor detail blob parse failed: %s", e)

        if not listing.price:
            listing.price = safe_text(self.driver, By.CSS_SELECTOR,
                                      "[data-testid='list-price']")
        if not listing.address:
            listing.address = safe_text(self.driver, By.CSS_SELECTOR, "h1")
        if not listing.description:
            listing.description = safe_text(
                self.driver, By.CSS_SELECTOR,
                "[data-testid='property-description']"
            )
        if not listing.photos:
            listing.photos = self._collect_photos()

        return listing

    def _extract_next_data(self):
        try:
            el = self.driver.find_element(By.ID, "__NEXT_DATA__")
            return json.loads(el.get_attribute("innerHTML"))
        except Exception:
            return None

    def _fill_from_property(self, listing, prop):
        listing.listing_id = (str(prop.get("property_id")
                                  or prop.get("listing_id") or "") or None)
        listing.price = self._fmt_price(prop.get("list_price")
                                        or prop.get("price"))

        loc = prop.get("location", {}) or {}
        addr = loc.get("address") or prop.get("address") or {}
        listing.address = self._fmt_address(addr)

        desc = prop.get("description", {}) or {}
        listing.beds = (str(desc.get("beds"))
                        if desc.get("beds") is not None else None)
        listing.baths = (str(desc.get("baths"))
                         if desc.get("baths") is not None else None)
        listing.sqft = str(desc.get("sqft")) if desc.get("sqft") else None
        listing.lot_size = (str(desc.get("lot_sqft"))
                            if desc.get("lot_sqft") else None)
        listing.year_built = (str(desc.get("year_built"))
                              if desc.get("year_built") else None)
        listing.property_type = desc.get("type") or desc.get("sub_type")
        listing.description = (desc.get("text")
                               or prop.get("description_text"))

        coords = (loc.get("address", {}) or {}).get("coordinate") or {}
        listing.latitude = coords.get("lat")
        listing.longitude = coords.get("lon")

        photos = []
        for p in (prop.get("photos") or []):
            href = p.get("href") or p.get("url")
            if href:
                photos.append(href)
        listing.photos = photos[:40]

        schools_blob = prop.get("schools") or {}
        if isinstance(schools_blob, dict):
            schools_list = schools_blob.get("schools") or []
        elif isinstance(schools_blob, list):
            schools_list = schools_blob
        else:
            schools_list = []
        if not schools_list and isinstance(prop.get("nearby_schools"), dict):
            schools_list = prop["nearby_schools"].get("schools") or []
        listing.schools = self._parse_schools(schools_list)

        listing.raw = {
            "hoa": prop.get("hoa"),
            "tax_history": prop.get("tax_history"),
            "price_history": prop.get("property_history"),
        }

    @staticmethod
    def _parse_schools(raw_schools):
        """Realtor.com school records:
          name, funding_type, education_levels, grades, distance_in_miles,
          ratings: {great_schools_rating, parent_rating}
        """
        out = []
        for s in raw_schools or []:
            if not isinstance(s, dict):
                continue
            ratings = s.get("ratings") or {}
            rating = (ratings.get("great_schools_rating")
                      or ratings.get("parent_rating")
                      or s.get("rating"))
            levels = s.get("education_levels") or []
            level = (levels[0].title() if levels else None) or s.get("level")
            url = s.get("web_url") or s.get("url")
            norm = normalize_school(
                name=s.get("name"),
                rating=rating,
                rating_scale="10",
                distance_mi=(s.get("distance_in_miles")
                             or s.get("distance")),
                grades=(s.get("grades")
                        or s.get("greatschools_grades")),
                school_type=((s.get("funding_type") or "").title() or None),
                level=level,
                url=url,
            )
            if norm:
                out.append(norm)
        return out

    @staticmethod
    def _fmt_price(p):
        if p is None:
            return None
        try:
            return "$" + format(int(p), ",")
        except (TypeError, ValueError):
            return str(p)

    @staticmethod
    def _fmt_address(a):
        if not a:
            return None
        parts = [a.get("line"), a.get("city"),
                 a.get("state_code") or a.get("state"),
                 a.get("postal_code")]
        return ", ".join(p for p in parts if p)

    def _collect_photos(self):
        urls = []
        for img in self.driver.find_elements(By.CSS_SELECTOR, "img"):
            src = img.get_attribute("src") or ""
            if (("rdcpix.com" in src or "rdc-photos" in src)
                    and src not in urls):
                urls.append(src)
        return urls[:25]
