# Model request timeout policy

Model calls should always have a finite timeout. A timeout must surface as a recoverable generation failure rather than leaving the browser waiting indefinitely.

When changing the timeout, verify both slow-provider behavior and normal generation latency. Keep provider error details out of user-facing responses unless they are safe and actionable.
