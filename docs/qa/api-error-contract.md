# API error contract

Client code should be able to distinguish invalid input, unavailable model configuration, rate limiting, provider failure, and malformed provider output.

Every error response should use a stable machine-readable `code` plus a concise human-readable `error` message. Avoid leaking provider credentials, stack traces, or internal file paths.
