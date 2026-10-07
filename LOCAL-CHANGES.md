# Local changes

This repository is a patched copy of [ABorakati/paseo-usage-monitor](https://github.com/ABorakati/paseo-usage-monitor) at base commit 528fff943872f0a33250478e6ae33ae628a572c3. The change below is not part of upstream.

Upstream updates include the plugin install type-boundary fix, npm packaging and CI, credential sources and Codex account matching, presets and pill observation, and Pi usage history.

- Record all available Codex rate-limit reset credits on normal refresh using
  one read-only detail GET. Add numbered expiry/grant readings and a soonest
  expiry reading using the existing rate schema; keep the banked-reset balance
  unchanged. Unknown expiries sort last. Detail failures preserve quota/balance
  readings and omit expiry metadata. Fixture service tests cover filtering,
  ordering, nulls, persistence, replacement, and GET-only requests.
