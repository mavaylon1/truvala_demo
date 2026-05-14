from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

# Loads ~/.env
load_dotenv(Path.home() / ".env")

client = OpenAI()

response = client.responses.create(
    model="gpt-4.1-mini",
    input="Say hello from the Truvala API test. Keep it to one sentence."
)

print(response.output_text)