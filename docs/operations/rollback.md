# Rollback checklist

If a deployment introduces generation or persistence regressions:

1. Confirm the failing route and error category.
2. Preserve the failing request shape without retaining private source material.
3. Roll back to the last known-good deployment.
4. Verify health and one representative worksheet flow.
5. Record the regression and corrective action before redeploying.
