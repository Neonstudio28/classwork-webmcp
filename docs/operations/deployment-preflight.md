# Deployment preflight

Before deploying the Classwork server, verify the build succeeds, required environment variables are configured only on the server, API host/origin checks match the deployed hostname, and production does not unexpectedly enable local SQLite persistence.

After deployment, exercise one read path and one generation error path before considering the release healthy.
