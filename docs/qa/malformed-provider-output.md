# Malformed provider output QA

Generation must fail closed when the model returns missing questions, unsupported question types, empty prompts, invalid standards, or missing required source evidence.

The existing worksheet should remain unchanged when validation fails; never partially commit a malformed generated worksheet.
