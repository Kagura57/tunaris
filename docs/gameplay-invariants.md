# Gameplay Invariants

These rules are product constraints and should be treated as non-negotiable.

1. A game starts only when the DB-backed track pool is fully prepared for the configured round count.
2. Answer suggestions must include the complete available suggestion set for the selected source (playlist or players liked library), not only the current round tracks.
3. MCQ distractors must be built from a broad candidate set to avoid repetitive choices.
4. External YouTube lookup/resolution is allowed progressively, but it must not block DB suggestion completeness.
5. YouTube round playback should start at a deterministic random offset based on track duration when duration data is available.
