# Provider timeout policy

Long-running model calls should have explicit time limits and cancellation behavior. A timeout must release request state and present a retry path rather than leaving the UI in a permanent loading state.