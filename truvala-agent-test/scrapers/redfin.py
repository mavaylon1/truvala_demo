"""Redfin scraper.

Redfin exposes most listing data via internal JSON endpoints under
/stingray/api/. We hit those via the Selenium-driven browser session so
cookies are present, with DOM scraping as fallback.
"""
from __future__ import annotations

import json
import logging
import re
from typing import List, Optional
from urllib.parse import urljoin

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


_REDFIN_PREFIX = re.compile(r"^\{\}&&")


class RedfinScraper(BaseScraper):
    SOURCE = "redfin"

    DETAIL_URL_RE = re.compile(r"/home/\d+", re.I)
    PROPERTY_ID_RE = re.compile(r"/home/(\d+)")

    def scrape(self, url):
        self.get(url)
        if self.check_blocked(("cf-browser-verification", "challenge-form")):
            log.warning("Redfin blocked the request; returning empty list.")
            return []
        if self.DETAIL_URL_RE.search(url):
            d = self._scrape_detail(url)
            return [d] if d else []
        return self._scrape_search(url)

    def _scrape_search(self, url):
        scroll_to_bottom(self.driver, step_px=900, max_steps=25)

        results = []
        seen = set()

        cards = self.driver.find_elements(By.CSS_SELECTOR, "div.HomeCardContainer")
        if not cards:
            cards = self.driver.find_elements(
                By.CSS_SELECTOR, "[data-rf-test-id='basicNode-homeCard']"
            )

        log.info("Redfin: found %d cards on search page", len(cards))

        for card in cards:
            try:
                a = card.find_element(By.CSS_SELECTOR, "a")
                href = a.get_attribute("href")
            except Exception:
                continue
            if not href or href in seen:
                continue
            seen.add(href)
            quick = Listing(
                source=self.SOURCE,
                url=href,
                price=safe_text(card, By.CSS_SELECTOR,
                                "[class*='homecardV2Price'], .Price"),
                address=safe_text(card, By.CSS_SELECTOR,
                                  ".homeAddressV2, [class*='address']"),
            )
            try:
                stats = card.find_elements(
                    By.CSS_SELECTOR, ".stats, [class*='Stats']"
                )
                for s in stats:
                    txt = s.text.lower()
                    if "bed" in txt and not quick.beds:
                        quick.beds = txt.split()[0]
                    if "bath" in txt and not quick.baths:
                        quick.baths = txt.split()[0]
                    if "sq" in txt and not quick.sqft:
                        quick.sqft = txt.split()[0]
            except Exception:
                pass
            results.append(quick)

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
                log.warning("Redfin: failed to enrich %s: %s", r.url, e)
                enriched.append(r)
        return enriched

    def _scrape_detail(self, url):
        try:
            self.wait().until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        except Exception:
            pass
        scroll_to_bottom(self.driver, step_px=600, max_steps=12)

        listing = Listing(source=self.SOURCE, url=self.driver.current_url)

        prop_id = self._extract_property_id(url)
        if prop_id:
            listing.listing_id = prop_id
            info = self._fetch_initial_info(prop_id)
            if info:
                self._fill_from_initial_info(listing, info)
            above = self._fetch_above_the_fold(prop_id)
            if above:
                self._fill_from_above_the_fold(listing, above)
            schools = self._fetch_schools(prop_id)
            if schools:
                listing.schools = self._parse_schools(schools)

        if not listing.price:
            listing.price = (safe_text(self.driver, By.CSS_SELECTOR,
                                       "div.statsValue")
                             or safe_text(self.driver, By.CSS_SELECTOR,
                                          "[data-rf-test-id='abp-price'] div"))
        if not listing.address:
            listing.address = (safe_text(self.driver, By.CSS_SELECTOR,
                                         ".street-address")
                               or safe_text(self.driver, By.CSS_SELECTOR, "h1"))
        if not listing.description:
            listing.description = safe_text(
                self.driver, By.CSS_SELECTOR,
                "#marketing-remarks-scroll, .remarks"
            )
        if not listing.photos:
            listing.photos = self._collect_photos()

        return listing

    def _extract_property_id(self, url):
        m = self.PROPERTY_ID_RE.search(url)
        return m.group(1) if m else None

    def _fetch_json(self, path):
        """Use the live browser session to GET an internal Redfin JSON endpoint."""
        url = urljoin("https://www.redfin.com", path)
        script = (
            "const cb = arguments[arguments.length - 1];"
            "fetch(" + json.dumps(url) +
            ", {credentials: 'include',"
            " headers: {'Accept': 'application/json'}})"
            ".then(r => r.text()).then(t => cb(t)).catch(e => cb(null));"
        )
        self.driver.set_script_timeout(20)
        try:
            body = self.driver.execute_async_script(script)
        except Exception as e:
            log.debug("Redfin fetch %s failed: %s", path, e)
            return None
        if not body:
            return None
        body = _REDFIN_PREFIX.sub("", body)
        try:
            return json.loads(body)
        except Exception:
            return None

    def _fetch_initial_info(self, property_id):
        return self._fetch_json(
            "/stingray/api/home/details/initialInfo?path=/home/" + property_id
        )

    def _fetch_above_the_fold(self, property_id):
        return self._fetch_json(
            "/stingray/api/home/details/aboveTheFold?propertyId="
            + property_id + "&accessLevel=1"
        )

    def _fetch_schools(self, property_id):
        """Redfin school info under several possible endpoints."""
        for path in (
            "/stingray/api/home/details/schools/serviceArea?propertyId="
            + property_id + "&accessLevel=1",
            "/stingray/api/home/details/schoolsAndDistricts?propertyId="
            + property_id + "&accessLevel=1",
        ):
            data = self._fetch_json(path)
            if not data:
                continue
            payload = data.get("payload") or {}
            buckets = []
            for key in ("serviceAreaSchools", "nearbySchools", "schools"):
                v = payload.get(key)
                if isinstance(v, list):
                    buckets.extend(v)
            if buckets:
                return buckets
        return None

    def _fill_from_initial_info(self, listing, info):
        payload = (info or {}).get("payload", {})
        listing.latitude = listing.latitude or payload.get("latitude")
        listing.longitude = listing.longitude or payload.get("longitude")

    def _fill_from_above_the_fold(self, listing, atf):
        payload = (atf or {}).get("payload", {}) or {}
        info = payload.get("addressSectionInfo", {}) or {}
        public = payload.get("publicRecordsInfo", {}) or {}
        basic = public.get("basicInfo", {}) or {}

        if not listing.price:
            listing.price = self._fmt_price(
                info.get("priceInfo", {}).get("amount")
            )

        full_addr_parts = [
            info.get("streetAddress", {}).get("assembledAddress"),
            info.get("city"),
            info.get("state"),
            info.get("zip"),
        ]
        if not listing.address:
            listing.address = ", ".join(p for p in full_addr_parts if p)

        if not listing.beds:
            listing.beds = self._strify(info.get("beds"))
        if not listing.baths:
            listing.baths = self._strify(info.get("baths"))
        if not listing.sqft:
            listing.sqft = self._strify(info.get("sqFt", {}).get("value"))
        if not listing.year_built:
            listing.year_built = self._strify(basic.get("yearBuilt"))
        if not listing.lot_size:
            listing.lot_size = self._strify(basic.get("lotSqFt"))
        if not listing.property_type:
            listing.property_type = basic.get("propertyTypeName")

        listing.raw.setdefault("publicRecords", public)
        listing.raw.setdefault("addressSectionInfo", info)

    @staticmethod
    def _parse_schools(raw_schools):
        """Redfin school dicts:
          name, greatSchoolsRating, parentRating, distanceInMiles,
          gradesRange, institutionType, institutionLevel, schoolReviewsUrl
        """
        out = []
        for s in raw_schools or []:
            if not isinstance(s, dict):
                continue
            rating = (s.get("greatSchoolsRating")
                      or s.get("rating")
                      or s.get("parentRating"))
            level = s.get("institutionLevel") or s.get("level")
            url = s.get("schoolReviewsUrl") or s.get("url")
            if url and url.startswith("/"):
                url = "https://www.redfin.com" + url
            norm = normalize_school(
                name=s.get("name"),
                rating=rating,
                rating_scale="10",
                distance_mi=s.get("distanceInMiles"),
                grades=s.get("gradesRange") or s.get("grades"),
                school_type=((s.get("institutionType") or "").title()
                             or None),
                level=level,
                url=url,
            )
            if norm:
                out.append(norm)
        return out

    @staticmethod
    def _strify(v):
        return str(v) if v not in (None, "") else None

    @staticmethod
    def _fmt_price(p):
        if p is None:
            return None
        try:
            return "$" + format(int(p), ",")
        except (TypeError, ValueError):
            return str(p)

    def _collect_photos(self):
        urls = []
        for img in self.driver.find_elements(By.CSS_SELECTOR, "img"):
            src = img.get_attribute("src") or ""
            if "ssl.cdn-redfin.com" in src and src not in urls:
                urls.append(src)
        return urls[:25]
