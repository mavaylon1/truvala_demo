import json
import os
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv


# Load ~/.env
load_dotenv(Path.home() / ".env")

api_key = os.getenv("RENTCAST_API_KEY")
if not api_key:
    raise RuntimeError("Missing RENTCAST_API_KEY in ~/.env")

base_url = "https://api.rentcast.io/v1/properties"

params = {
    "city": "Austin",
    "state": "TX",
    "limit": 5,
}

url = f"{base_url}?{urlencode(params)}"

request = Request(
    url,
    headers={
        "Accept": "application/json",
        "X-Api-Key": api_key,
    },
    method="GET",
)

with urlopen(request) as response:
    data = json.loads(response.read().decode("utf-8"))

print(json.dumps(data, indent=2))