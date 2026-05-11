import asyncio
from agents import Agent, Runner, function_tool


@function_tool
def get_listing_status(url: str) -> str:
    """Checks whether a URL looks like a real estate listing."""
    if any(site in url for site in ["zillow.com", "trulia.com", "redfin.com"]):
        return "This looks like a supported real estate listing page."
    return "This does not look like a supported listing page."


agent = Agent(
    name="Truvala Hello Agent",
    instructions=(
        "You are a real estate analysis assistant. "
        "When given a URL, use the get_listing_status tool before answering."
    ),
    tools=[get_listing_status],
)


async def main():
    result = await Runner.run(
        agent,
        "Check this page: https://www.trulia.com/home/example-listing",
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())