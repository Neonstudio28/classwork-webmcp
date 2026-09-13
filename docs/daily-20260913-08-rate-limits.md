# Rate-limit behavior

Provider rate limits should be handled as recoverable failures. Preserve user input, avoid immediate retry storms, and surface a retry path with enough context for the user to understand that the provider is temporarily unavailable.