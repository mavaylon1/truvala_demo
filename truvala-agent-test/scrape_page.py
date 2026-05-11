import json
import sys
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


def scrape_page(url: str) -> dict:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) "
            "Version/18.6 Safari/605.1.15"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }

    response = requests.get(url, headers=headers, timeout=20)
    response.raise_for_status()

    html = response.text
    soup = BeautifulSoup(html, "html.parser")

    title = soup.title.get_text(strip=True) if soup.title else ""

    meta = {}
    for tag in soup.find_all("meta"):
        key = tag.get("property") or tag.get("name")
        value = tag.get("content")
        if key and value:
            meta[key] = value

    images = []
    for img in soup.find_all("img"):
        src = img.get("src")
        if not src:
            continue

        images.append({
            "src": urljoin(url, src),
            "alt": img.get("alt", "")
        })

    # Remove scripts/styles so text is closer to what a basic scraper would see
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    raw_text = soup.get_text(separator="\n")

    # Light cleanup only: remove empty lines, but do not structure/normalize fields
    raw_lines = [
        line.strip()
        for line in raw_text.splitlines()
        if line.strip()
    ]

    return {
        "url": url,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "status_code": response.status_code,
        "page_title": title,
        "meta": meta,
        "images": images,
        "raw_text": "\n".join(raw_lines),
        "raw_line_count": len(raw_lines),
        "html_length": len(html),
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scrape_page.py <url>")

    url = sys.argv[1]
    result = scrape_page(url)

    print(json.dumps(result, indent=2, ensure_ascii=False))