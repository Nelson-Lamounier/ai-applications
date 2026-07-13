# matching/

Shared matching primitives — the ONE place fuzzy matching lives. Normalise/canon,
token match, alias maps, and the tier ladder (`matchTerm`). Consumed by `coverage/`
(the ATS gate), `grounding/` (ledger + demotions), `reconcile/`, and `context/`.
Pure functions; no I/O.
