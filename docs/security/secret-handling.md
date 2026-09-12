# Secret handling

Provider credentials belong only in server-side environment variables. Browser bundles must never receive model API keys.

Do not add `.env` files containing credentials to source control. When debugging provider calls, log status categories and safe request metadata rather than request bodies or secrets.
