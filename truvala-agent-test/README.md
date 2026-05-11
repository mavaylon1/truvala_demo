# Truvala Agent MVP Scratch Setup

This repo is a small testbed for the Truvala browser-extension MVP flow.

The current goal is:

```text
Browser listing page
→ raw browser DOM scrape
→ cached raw JSON file
→ AI extraction
→ structured listing JSON
```

This is not the final extension yet. This is just the manual version so we can understand what the backend will receive.

---

## 1. Activate the Conda environment

```bash
conda activate truvala-agent
```

Check Python:

```bash
python --version
```

---

## 2. Install required packages

```bash
pip install openai requests beautifulsoup4
```

`requests` and `beautifulsoup4` are useful for basic server-side scraping tests, but some real estate sites block server-side scraping.

For Trulia/Zillow/Redfin, the browser DOM scrape is usually more realistic.

---

## 3. Set your OpenAI API key

```bash
export OPENAI_API_KEY="your-api-key-here"
```

Do not commit or share this key.

If you accidentally pasted a real key into chat, terminal logs, GitHub, or anywhere public, revoke it and create a new one.

---

## 4. Why browser DOM scraping instead of Python requests?

A normal Python request looks like this:

```text
Python requests
→ Trulia server
→ often blocked with 403 Forbidden
```

That happened with Trulia.

The browser-extension approach is different:

```text
User opens listing page normally
→ browser renders the page
→ extension reads the already-loaded page DOM
→ extension sends the visible page text to backend
```

So for this MVP, the realistic input is closer to:

```javascript
document.body.innerText
```

not a backend `requests.get(url)` scrape.

---

## 5. Manually generate raw browser scrape JSON

Open the listing page in Chrome.

Example:

```text
https://www.trulia.com/home/94-yorktown-newport-beach-ca-92660-118261308
```

Then:

1. Right-click on the page.
2. Click **Inspect**.
3. Click the **Console** tab.
4. Paste the JavaScript below.
5. Press **Enter**.

```javascript
const payload = {
  url: window.location.href,
  page_title: document.title,
  visible_text: document.body.innerText,
  html_snapshot_length: document.body.innerHTML.length,
  scraped_at: new Date().toISOString(),
  images: Array.from(document.images).slice(0, 50).map(img => ({
    src: img.src,
    alt: img.alt || "",
    width: img.naturalWidth,
    height: img.naturalHeight
  })),
  meta: Object.fromEntries(
    Array.from(document.querySelectorAll("meta"))
      .map(tag => [
        tag.getAttribute("property") || tag.getAttribute("name"),
        tag.getAttribute("content")
      ])
      .filter(([key, value]) => key && value)
  )
};

copy(JSON.stringify(payload, null, 2));
console.log("Copied raw scrape JSON to clipboard", payload);
```

This copies the raw scrape JSON to your clipboard.

Now go back to Terminal and save it:

```bash
pbpaste > trulia_dom_scrape.json
```

Check that it worked:

```bash
head -40 trulia_dom_scrape.json
```

The first line should be:

```json
{
```

If the file starts with this instead:

```bash
pbpaste > trulia_dom_scrape.json
```

then the clipboard had the terminal command instead of the JSON. Go back to Chrome Console and run the JavaScript again.

---

## 6. Inspect the raw scrape

Pretty-print the JSON:

```bash
python -m json.tool trulia_dom_scrape.json | less
```

Preview only the visible text:

```bash
python - <<'PY'
import json

with open("trulia_dom_scrape.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print(data["visible_text"][:5000])
PY
```

The important field is:

```json
"visible_text": "..."
```

This contains the messy listing text, navigation text, similar homes, legal text, school info, and other page content.

---

## 7. Extract structured listing JSON

Run:

```bash
python extract_listing.py trulia_dom_scrape.json
```

This creates:

```text
structured_listing.json
```

Open it:

```bash
open structured_listing.json
```

Or inspect in terminal:

```bash
python -m json.tool structured_listing.json | less
```

Expected output shape:

```json
{
  "address": "94 Yorktown",
  "city": "Newport Beach",
  "state": "CA",
  "zip": 92660,
  "price": 379000,
  "original_price": 409000,
  "beds": 2,
  "baths": 2,
  "sqft": 1029,
  "lot_size_text": "12.75 acres",
  "year_built": 1961,
  "property_type": "Manufactured In Park",
  "property_subtype": "Manufactured Home",
  "hoa_fee_monthly": 0,
  "land_lease_monthly": 3300,
  "listing_status": "Active",
  "days_on_market": 180,
  "mls_number": "NP26000828",
  "description": "...",
  "source_url": "https://www.trulia.com/home/...",
  "price_history": [],
  "warnings": [],
  "missing_fields": [],
  "source_snippets": {},
  "extraction_confidence": "high"
}
```

---

## 8. Clean cached/generated files

To remove generated scrape and extraction files:

```bash
rm -f trulia_dom_scrape.json structured_listing.json
```

If you also created the blocked server-side scrape file:

```bash
rm -f trulia_raw_scrape.json
```

Clean all generated JSON outputs:

```bash
rm -f *_scrape.json structured_listing.json trulia_raw_scrape.json trulia_dom_scrape.json
```

---

## 9. Export the Conda environment

For an exact Conda export:

```bash
conda list --explicit > truvala-agent-explicit.txt
```

For a more readable environment file:

```bash
conda env export --no-builds > truvala-agent-environment.yml
```

For pip packages:

```bash
pip freeze > truvala-agent-pip-freeze.txt
```

To recreate from the exact Conda file later:

```bash
conda create --name truvala-agent --file truvala-agent-explicit.txt
```

---

## Current MVP flow

```text
Chrome Console scrape
→ trulia_dom_scrape.json
→ extract_listing.py
→ structured_listing.json
```

Next backend step:

```text
structured_listing.json
→ validate_listing.py
→ normalize_listing.py
→ score_property.py
→ basic report
```
