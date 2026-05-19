"""Zillow scraper (hardened).

Zillow embeds listing data inside `__NEXT_DATA__`, but the *shape* of that
blob varies across builds, A/B buckets, and login state. This scraper:

  - Tries every known data path for the property record (gdpClientCache,
    initialReduxState.gdp.property, dehydratedState.queries[*].state.data,
    pageProps.property, searchPageContext) and falls back to a recursive
    walk that picks the dict with `zpid`.

  - Tries every known data path for schools (property.schools,
    schoolsModule.schools, searchPageContext.schools, etc.) and falls back
    to a recursive walk that picks any list-of-school-dicts node.

  - Handles BOTH school shapes Zillow has shipped:
      * flat list:  [{"name": ..., "rating": ..., ...}, ...]
      * grouped dict: {"elementary": {...}, "middle": [...], "high": {...}}
      * "served by"/"nearby" dict: {"servingThis": [...], "nearby": [...]}

  - Warns when the page looks degraded (PerimeterX often serves a stripped
    __NEXT_DATA__ where price/address are present but schools/photos/
    description are missing).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterable, List, Optional
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


class ZillowScraper(BaseScraper):
    SOURCE = "zillow"

    DETAIL_URL_RE = re.compile(r"/homedetails/", re.I)

    # Keys whose values, when found anywhere in __NEXT_DATA__, may contain
    # a list of school dicts. Order = preferred-first.
    SCHOOL_KEYS = (
        "schools", "nearbyHomesAndSchools", "schoolsModule",
        "assignedSchools", "nearbySchools",
    )

    def scrape(self, url):
        self.get(url)
        if self.check_blocked():
            log.warning("Zillow blocked the request; returning empty list.")
            return []
        if self.DETAIL_URL_RE.search(url):
            listing = self._scrape_detail(url)
            return [listing] if listing else []
        return self._scrape_search(url)

    # ------------------------------------------------------------------ search

    def _scrape_search(self, url):
        scroll_to_bottom(self.driver)
        results = []
        seen = set()

        cards = self.driver.find_elements(
            By.CSS_SELECTOR, "article[data-test='property-card']"
        )
        log.info("Zillow: found %d cards on search page", len(cards))

        for card in cards:
            try:
                link = card.find_element(
                    By.CSS_SELECTOR, "a[data-test='property-card-link']"
                )
                href = link.get_attribute("href")
            except Exception:
                continue
            if not href or href in seen:
                continue
            seen.add(href)
            quick = Listing(
                source=self.SOURCE,
                url=href,
                price=safe_text(card, By.CSS_SELECTOR,
                                "[data-test='property-card-price']"),
                address=safe_text(card, By.CSS_SELECTOR, "address"),
            )
            try:
                items = card.find_elements(By.CSS_SELECTOR, "ul li")
                for li in items:
                    text = li.text.strip().lower()
                    if "bd" in text and not quick.beds:
                        quick.beds = text.split()[0]
                    elif "ba" in text and not quick.baths:
                        quick.baths = text.split()[0]
                    elif "sqft" in text and not quick.sqft:
                        quick.sqft = text.split()[0]
            except Exception:
                pass
            results.append(quick)

        enriched = []
        for r in results:
            try:
                self.get(r.url)
                detail = self._scrape_detail(r.url)
                if detail:
                    detail.price = detail.price or r.price
                    detail.address = detail.address or r.address
                    detail.beds = detail.beds or r.beds
                    detail.baths = detail.baths or r.baths
                    detail.sqft = detail.sqft or r.sqft
                    enriched.append(detail)
                else:
                    enriched.append(r)
                human_pause(2.0, 4.5)
            except Exception as e:
                log.warning("Zillow: failed to enrich %s: %s", r.url, e)
                enriched.append(r)
        return enriched

    # ------------------------------------------------------------------ detail

    def _scrape_detail(self, url):
        try:
            self.wait().until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
        except Exception:
            pass
        scroll_to_bottom(self.driver, step_px=600, max_steps=10)

        blob = self._extract_next_data()
        listing = Listing(source=self.SOURCE, url=self.driver.current_url)

        if blob:
            try:
                prop = self._find_property(blob)
                if prop:
                    self._fill_from_property(listing, prop)
                # Even if we got a property record, schools may live elsewhere
                # in the blob. Look there too, and only overwrite if empty.
                if not listing.schools:
                    raw_schools = self._find_schools_in_blob(blob)
                    if raw_schools:
                        listing.schools = self._parse_schools(raw_schools)
            except Exception as e:
                log.debug("Zillow: NEXT_DATA parse failed: %s", e)

        # DOM fallbacks for anything the blob didn't have.
        if not listing.price:
            listing.price = safe_text(
                self.driver, By.CSS_SELECTOR, "[data-testid='price'] span"
            )
        if not listing.address:
            listing.address = safe_text(self.driver, By.CSS_SELECTOR, "h1")
        if not listing.description:
            listing.description = safe_text(
                self.driver, By.CSS_SELECTOR, "[data-testid='description'] div"
            )
        if not listing.photos:
            listing.photos = self._collect_photos()
        if not listing.schools:
            dom_schools = self._collect_schools_from_dom()
            if dom_schools:
                listing.schools = dom_schools

        self._warn_if_degraded(listing)
        return listing

    # ----------------------------------------------------------- blob parsing

    def _extract_next_data(self):
        try:
            el = self.driver.find_element(By.ID, "__NEXT_DATA__")
            return json.loads(el.get_attribute("innerHTML"))
        except Exception:
            return None

    def _find_property(self, blob):
        """Walk every known data path for the property record, returning
        the first dict that looks like a Zillow property. Falls back to a
        recursive search for any dict containing `zpid`."""
        page_props = (blob.get("props", {}) or {}).get("pageProps", {}) or {}
        component_props = page_props.get("componentProps", {}) or {}

        # 1. Legacy: stringified JSON cache.
        cache_str = component_props.get("gdpClientCache")
        if isinstance(cache_str, str):
            try:
                cache = json.loads(cache_str)
                for v in cache.values():
                    if isinstance(v, dict) and isinstance(v.get("property"), dict):
                        return v["property"]
            except Exception:
                pass

        # 2. Same cache, but already a dict (newer builds).
        if isinstance(component_props.get("gdpClientCache"), dict):
            for v in component_props["gdpClientCache"].values():
                if isinstance(v, dict) and isinstance(v.get("property"), dict):
                    return v["property"]

        # 3. Redux state path.
        irs = component_props.get("initialReduxState") or {}
        for path in (
            ["gdp", "property"],
            ["gdp", "byZpid"],
            ["propertyDetails", "data"],
        ):
            node = irs
            for k in path:
                node = (node or {}).get(k) if isinstance(node, dict) else None
            if isinstance(node, dict):
                if "zpid" in node:
                    return node
                # byZpid -> {zpid: property} shape.
                for v in node.values():
                    if isinstance(v, dict) and "zpid" in v:
                        return v

        # 4. TanStack / dehydratedState (newer Next.js builds).
        dh = page_props.get("dehydratedState") or {}
        for q in (dh.get("queries") or []):
            data = (((q or {}).get("state") or {}).get("data")) or {}
            if isinstance(data, dict):
                cand = data.get("property") or data
                if isinstance(cand, dict) and "zpid" in cand:
                    return cand

        # 5. searchPageContext (sometimes carries a single-listing detail).
        spc = component_props.get("searchPageContext") or {}
        if isinstance(spc.get("property"), dict) and "zpid" in spc["property"]:
            return spc["property"]

        # 6. Last resort: recursive walk for any dict with `zpid` and meaningful
        #    breadth. Prefer the dict with the most keys.
        candidates = []
        for node in _walk_dicts(blob):
            if "zpid" in node and ("price" in node or "bedrooms" in node
                                   or "livingArea" in node):
                candidates.append(node)
        if candidates:
            return max(candidates, key=lambda d: len(d))
        return None

    def _find_schools_in_blob(self, blob):
        """Return a list of raw school dicts from anywhere in __NEXT_DATA__.

        Handles flat lists, grouped-by-level dicts, and serving/nearby dicts.
        """
        candidates: List[Any] = []
        for node in _walk_dicts(blob):
            for k in self.SCHOOL_KEYS:
                if k in node:
                    candidates.append(node[k])

        # Flatten every candidate into a list of dicts that look like schools.
        out: List[dict] = []
        seen_names = set()
        for cand in candidates:
            for s in _coerce_school_list(cand):
                key = (s.get("name"), s.get("level") or s.get("grades"))
                if key in seen_names:
                    continue
                seen_names.add(key)
                out.append(s)
        return out

    # ----------------------------------------------------------- fill listing

    def _fill_from_property(self, listing, prop):
        listing.listing_id = str(prop.get("zpid") or "") or None
        listing.price = self._fmt_price(prop.get("price"))
        listing.address = self._fmt_address(prop.get("address"))
        listing.beds = (str(prop.get("bedrooms"))
                        if prop.get("bedrooms") is not None else None)
        listing.baths = (str(prop.get("bathrooms"))
                         if prop.get("bathrooms") is not None else None)
        listing.sqft = (str(prop.get("livingArea"))
                        if prop.get("livingArea") else None)
        listing.year_built = (str(prop.get("yearBuilt"))
                              if prop.get("yearBuilt") else None)
        lot = prop.get("lotSize") or prop.get("lotAreaValue")
        if lot:
            unit = prop.get("lotAreaUnit", "")
            listing.lot_size = (str(lot) + " " + unit).strip()
        listing.property_type = (prop.get("homeType")
                                 or prop.get("propertyTypeDimension"))
        listing.description = prop.get("description")
        listing.latitude = prop.get("latitude")
        listing.longitude = prop.get("longitude")

        photos = []
        for p in (prop.get("originalPhotos") or []):
            mixed = (p or {}).get("mixedSources", {}) or {}
            for fmt in ("jpeg", "webp"):
                arr = mixed.get(fmt) or []
                if arr:
                    photos.append(arr[-1].get("url"))
                    break
        listing.photos = [u for u in photos if u]

        listing.schools = self._parse_schools(prop.get("schools"))

        listing.raw = {
            "hoaFee": prop.get("monthlyHoaFee"),
            "daysOnZillow": prop.get("daysOnZillow"),
            "priceHistory": prop.get("priceHistory"),
        }

    def _parse_schools(self, raw):
        """Normalize whatever shape we got into a list of school dicts."""
        out = []
        for s in _coerce_school_list(raw):
            link = s.get("link") or s.get("url")
            if link and isinstance(link, str) and link.startswith("/"):
                link = "https://www.zillow.com" + link
            # Zillow rating fields have wandered across builds.
            rating = (s.get("rating") or s.get("greatSchoolsRating")
                      or s.get("schoolRating") or s.get("gsRating"))
            norm = normalize_school(
                name=s.get("name") or s.get("schoolName"),
                rating=rating,
                rating_scale="10",
                distance_mi=(s.get("distance")
                             or s.get("distanceInMiles")),
                grades=s.get("grades") or s.get("gradeRange"),
                school_type=s.get("type") or s.get("schoolType"),
                level=s.get("level") or s.get("schoolLevel"),
                url=link,
            )
            if norm:
                out.append(norm)
        return out

    # ------------------------------------------------------------- DOM helpers

    def _collect_schools_from_dom(self):
        """Last-resort: scrape the rendered school card list from the DOM.

        Zillow's schools section renders as a series of cards, each with
        a numeric rating badge + name + level + distance. Selectors drift
        often; we use forgiving regex on the visible text.
        """
        try:
            section = self.driver.find_element(
                By.CSS_SELECTOR, "[data-testid='schools-section']"
            )
        except Exception:
            return []

        out = []
        rows = section.find_elements(By.CSS_SELECTOR, "li, [role='listitem']")
        for row in rows:
            text = (row.text or "").strip()
            if not text:
                continue
            # Pattern: "8 / 10\nWalnut Hills Elem\nGrades K-5\n0.4 mi"
            rating_m = re.search(r"\b(\d{1,2})\s*/\s*10\b", text)
            dist_m = re.search(r"([\d.]+)\s*mi", text)
            grades_m = re.search(r"Grades?\s*([\w-]+)", text, re.I)
            level_m = re.search(r"\b(Elementary|Middle|High|K-?8|K-?12)\b",
                                text, re.I)
            # Name = first line that isn't a rating/grades/distance/level line.
            name = None
            for line in text.splitlines():
                ll = line.strip()
                if (not ll
                        or re.fullmatch(r"\d{1,2}\s*/\s*10", ll)
                        or re.fullmatch(r"[\d.]+\s*mi", ll)
                        or re.match(r"Grades?\s", ll, re.I)
                        or ll.lower() in {"elementary", "middle", "high"}):
                    continue
                name = ll
                break
            if not name:
                continue
            norm = normalize_school(
                name=name,
                rating=int(rating_m.group(1)) if rating_m else None,
                rating_scale="10",
                distance_mi=dist_m.group(1) if dist_m else None,
                grades=grades_m.group(1) if grades_m else None,
                level=level_m.group(1).title() if level_m else None,
            )
            if norm:
                out.append(norm)
        return out

    def _collect_photos(self):
        urls = []
        for img in self.driver.find_elements(By.CSS_SELECTOR, "img"):
            src = img.get_attribute("src") or ""
            if "zillowstatic.com" in src and src not in urls:
                urls.append(urljoin(self.driver.current_url, src))
        return urls[:25]

    def _warn_if_degraded(self, listing):
        """PerimeterX often serves a stripped page: price/address present but
        schools, photos, description, and history empty. Surface it."""
        thin = (not listing.schools
                and not listing.photos
                and not listing.description
                and not (listing.raw or {}).get("priceHistory"))
        if thin and (listing.price or listing.address):
            log.warning(
                "Zillow: got listing %s but schools/photos/description are "
                "all empty - PerimeterX likely served a degraded page. "
                "Try --headed, a residential proxy, or undetected-chromedriver.",
                listing.url,
            )

    # ------------------------------------------------------------- formatting

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
        parts = [a.get("streetAddress"), a.get("city"),
                 a.get("state"), a.get("zipcode")]
        return ", ".join(p for p in parts if p)


# ===================================================================
# Module-level helpers
# ===================================================================

def _walk_dicts(node):
    """Yield every dict found inside a nested JSON-like structure."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk_dicts(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_dicts(v)


def _looks_like_school(d):
    """Heuristic: a dict is a school record if it has a name plus at least
    one of {rating, level, grades, distance}."""
    if not isinstance(d, dict):
        return False
    has_name = bool(d.get("name") or d.get("schoolName"))
    has_signal = any(k in d for k in (
        "rating", "greatSchoolsRating", "schoolRating", "gsRating",
        "level", "schoolLevel", "grades", "gradeRange",
        "distance", "distanceInMiles",
    ))
    return has_name and has_signal


def _coerce_school_list(raw):
    """Turn whatever Zillow gave us into a flat list of school dicts.

    Accepts:
      - None / empty -> []
      - list of school dicts -> same list
      - list of mixed (some schools, some buckets) -> flattened
      - dict keyed by school level (elementary/middle/high) -> values
      - dict keyed by servingThis/nearby -> values
      - dict with .schools field -> recurse
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        out = []
        for item in raw:
            if _looks_like_school(item):
                out.append(item)
            else:
                out.extend(_coerce_school_list(item))
        return out
    if isinstance(raw, dict):
        # Single school?
        if _looks_like_school(raw):
            return [raw]
        # Container of schools?
        out = []
        for k, v in raw.items():
            if k.lower() in {
                "schools", "nearbyhomesandschools", "schoolsmodule",
                "assignedschools", "nearbyschools", "servingthis",
                "servingthishome", "nearby", "elementary", "middle", "high",
                "primary", "secondary",
            }:
                out.extend(_coerce_school_list(v))
        if out:
            return out
        # Last-ditch: walk every value.
        for v in raw.values():
            out.extend(_coerce_school_list(v))
        return out
    return []