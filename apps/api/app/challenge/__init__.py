"""Challenge module: the place for case-specific code written on the day.

* ``analyses.py`` — register case analyses with ``category="challenge"``; they appear on the
  Challenge page automatically with a generated parameter form.
* ``router.py`` — add bespoke endpoints under ``/api/v1/challenge`` when a generic analysis result
  (summary + table + chart) is not enough.

See docs/tomorrow-playbook.md, scenario F.
"""

from app.challenge import analyses  # noqa: F401  (registration side effect)
