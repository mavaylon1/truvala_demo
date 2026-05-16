"""Base scraper utilities shared across Zillow, Realtor.com, Redfin, Trulia."""
from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, List, Optional

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

try:
    from webdriver_manager.chrome import ChromeDriverManager
    from selenium.webdriver.chrome.service import Service as ChromeService
    _HAS_WDM = True
except ImportError:
    _HAS_WDM = False


log = logging.getLogger(__name__)


USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]


@dataclass
class Listing:
    """Normalized listing record produced by every site scraper."""

    source: str
    url: str
    address: Optional[str] = None
    price: Optional[str] = None
    beds: Optional[str] = None
    baths: Optional[str] = None
    sqft: Optional[str] = None
    lot_size: Optional[str] = None
    year_built: Optional[str] = None
    property_type: Optional[str] = None
    description: Optional[str] = None
    photos: List[str] = field(default_factory=list)
    listing_id: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    schools: List[dict] = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def build_driver(headless=True, proxy=None, user_agent=None, window_size="1366,900"):
    """Construct a stealth-ish Chrome WebDriver."""
    opts = ChromeOptions()
    if headless:
        opts.add_argument("--headless=new")

    ua = user_agent or random.choice(USER_AGENTS)
    opts.add_argument("--user-agent=" + ua)
    opts.add_argument("--window-size=" + window_size)
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--lang=en-US,en;q=0.9")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)

    if proxy:
        opts.add_argument("--proxy-server=" + proxy)

    if _HAS_WDM:
        driver = webdriver.Chrome(
            service=ChromeService(ChromeDriverManager().install()),
            options=opts,
        )
    else:
        driver = webdriver.Chrome(options=opts)

    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {
            "source": (
                "Object.defineProperty(navigator, 'webdriver', "
                "{get: () => undefined});"
                "window.chrome = {runtime: {}};"
                "Object.defineProperty(navigator, 'languages', "
                "{get: () => ['en-US', 'en']});"
                "Object.defineProperty(navigator, 'plugins', "
                "{get: () => [1, 2, 3, 4, 5]});"
            )
        },
    )
    return driver


def human_pause(low=1.2, high=3.4):
    time.sleep(random.uniform(low, high))


def scroll_to_bottom(driver, step_px=800, max_steps=30):
    """Slowly scroll to trigger lazy-loaded content."""
    last_height = driver.execute_script("return document.body.scrollHeight")
    for _ in range(max_steps):
        driver.execute_script("window.scrollBy(0, " + str(step_px) + ");")
        time.sleep(random.uniform(0.4, 0.9))
        new_height = driver.execute_script("return document.body.scrollHeight")
        if new_height == last_height:
            break
        last_height = new_height


def normalize_school(name=None, rating=None, rating_scale="10",
                     distance_mi=None, grades=None, school_type=None,
                     level=None, url=None):
    """Return a normalized school dict, or None if there's no useful content."""
    if not name:
        return None
    dist = None
    if distance_mi not in (None, ""):
        try:
            dist = float(distance_mi)
        except (TypeError, ValueError):
            dist = None
    return {
        "name": name,
        "rating": str(rating) if rating not in (None, "") else None,
        "rating_scale": rating_scale,
        "distance_mi": dist,
        "grades": grades,
        "type": school_type,
        "level": level,
        "url": url,
    }


def safe_text(parent, by, selector):
    try:
        return parent.find_element(by, selector).text.strip() or None
    except Exception:
        return None


def safe_attr(parent, by, selector, attr):
    try:
        return parent.find_element(by, selector).get_attribute(attr)
    except Exception:
        return None


class BaseScraper:
    """Base class - every site scraper implements scrape(url)."""

    SOURCE = "base"

    def __init__(self, headless=True, proxy=None, page_load_timeout=45,
                 wait_timeout=20, driver=None):
        self.headless = headless
        self.proxy = proxy
        self.page_load_timeout = page_load_timeout
        self.wait_timeout = wait_timeout
        self._driver = driver
        self._owns_driver = driver is None

    def __enter__(self):
        _ = self.driver
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    @property
    def driver(self):
        if self._driver is None:
            self._driver = build_driver(headless=self.headless, proxy=self.proxy)
            self._driver.set_page_load_timeout(self.page_load_timeout)
        return self._driver

    def wait(self):
        return WebDriverWait(self.driver, self.wait_timeout)

    def close(self):
        if self._driver is not None and self._owns_driver:
            try:
                self._driver.quit()
            except Exception:
                pass
            self._driver = None

    def scrape(self, url):
        """Given a search URL or a single listing detail URL, return listings."""
        raise NotImplementedError

    def get(self, url):
        log.info("[%s] GET %s", self.SOURCE, url)
        self.driver.get(url)
        human_pause()

    def check_blocked(self, markers=()):
        """Return True if the page looks like a bot-check / captcha / 403."""
        default_markers = (
            "Press & Hold to confirm",
            "Please verify you are a human",
            "perimeterx",
            "px-captcha",
            "Access to this page has been denied",
            "captcha",
            "Are you a robot",
        )
        html = self.driver.page_source.lower()
        for m in list(markers) + list(default_markers):
            if m.lower() in html:
                log.warning("[%s] looks blocked - marker %r found", self.SOURCE, m)
                return True
        return False
