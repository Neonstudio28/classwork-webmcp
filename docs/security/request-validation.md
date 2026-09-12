# API request validation checklist

Mutation endpoints must validate the request host, origin, fetch-site metadata, and JSON content type before reading application payloads.

Keep validation failures generic enough not to disclose server configuration. Never include API keys or raw authorization material in error responses.
