# To do

- Replace the fixed saved-strategy text and the generic saved-Token-Finder text
  in their save dialogs with the signed-in user’s live entitlement. Read
  `max_strategies`, `strategies_saved`, `max_finders`, and `finders_saved` from
  the authenticated `GET /billing/status` response and present the applicable
  tier limit (including an appropriate unlimited-plan message). Keep it
  synchronized with the API’s existing library caps in
  `crypto-data-collector/api/server.py` so the UI never promises a limit
  different from the one enforced by the service.
