"""Conversation Quality Analytics (CQA): a self-contained application area inside ATLAS.

* ``ingestion.py``   organizers' API (GET by group_id), payload parsing, labeled fixtures
* ``checklists.py``  checklist configuration with immutable versions
* ``scoring.py``     the deterministic scoring engine (the only place scores are computed)
* ``contract.py``    the evaluator integration contract (request, strict output schema, validation)
* ``adapters/``      evaluator adapters: ``mock`` (development only) and ``http``; the real model plugs in here
* ``evaluations.py`` evaluation lifecycle (pending → running → completed | failed)
* ``appeals.py``     appeals, reviewer decisions, final-score recalculation
* ``store.py``       JSON persistence under data/workspaces/cqa and the audit trail
* ``router.py``      HTTP API under /api/v1/cqa

See docs/cqa.md and docs/cqa-model-contract.md.
"""
