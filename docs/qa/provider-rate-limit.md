# Provider rate-limit QA

When the model provider returns HTTP 429, the API should expose the stable `MODEL_RATE_LIMITED` error category and a safe retry message.

Verify the UI leaves the worksheet intact, does not automatically hammer the provider with immediate retries, and gives the user a clear recovery path.
