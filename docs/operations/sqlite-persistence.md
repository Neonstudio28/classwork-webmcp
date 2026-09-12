# SQLite persistence operations

Local persistence uses a SQLite database outside Vercel deployments. The data directory can be overridden with `CLASSWORK_DATA_DIR`.

Before deployment changes, verify that production environments do not accidentally write local SQLite files and that backup/restore expectations are documented for any environment that does persist workspaces.
