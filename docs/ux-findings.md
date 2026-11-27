# UX findings: the dashboard as a newcomer sees it

Captured with `npm run ux:captures` (every page and state below, 390 and 1280 px, from the README's demo data).
Severity: 1 blocks understanding, 2 confuses, 3 polish. **Fixed** rows were fixed in GY-3962 (Lead/Settings wording rows in GY-3994); the rest are for follow-up items.
Rules: *plain* (one plain sentence per idea, owner first), *next* (state, numbers and the one next action),
*internal* (no ids, hashes, model ids, jargon or agent chatter outside Details), *error* (says what to do, never false),
*twice* (show nothing twice), *fit* (390 and 1280 px, no sideways scroll).

## Home

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Summary section | "3 moving · 0 blocked · 0 up next" again under the "3 are moving" line, plus three cards repeating the top menu | twice | 2 | Fixed |
| Needs you row | The request led by its task key "DEMO-106" instead of what it is about | internal | 2 | Fixed |
| Status line | "No test machines" with no word on where tests run instead | next | 2 | Fixed |
| Status line | "1 Builder working" beside the header's "3 agents working": two counts of the same crew | twice | 2 | Open |
| Status line | Five large phrases run together with no separators at 1280 px | plain | 3 | Open |
| Active goals and Now | "Now: Export monthly invoices as CSV" floats alone between panels | plain | 3 | Open |

## Work

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Header strip and filters | "18 merged today" in the strip and "Shipped today 18" on the filter chip (kept: other cases pin both) | twice | 2 | Open |
| Header line and filters | "3 in flight" opens the header line and the "In flight 3" chip repeats it (kept: pinned as matching) | twice | 2 | Open |
| Header strip | "18 shipped · 0 going live" counts the week, "18 merged today" counts today, with no word on which is which | plain | 2 | Open |
| Now column | "Running merge trial on latest main", "checking diff and proofs" | internal | 2 | Open |
| Flow line | "3.4 attempts an hour · 74% first pass": builder metrics before the owner's question "is it moving" | plain | 3 | Open |
| Under the heading | A rotating quote ("Real artists ship.") takes a line above the work | plain | 3 | Open |
| Rotating line | "Fresh worktree, fresh start." or "Agents drift through the worktree like rain down a window." on some loads (found by the rules case, not the captures) | internal | 3 | Fixed |
| 390 px | The fixed bottom menu covers the first row of the goal table when scrolled | fit | 3 | Open |

## A change: Checks and diff (and every tab's header)

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Header | "DEMO-103 · e4f8a2c9": task key and commit hash under the title | internal | 1 | Fixed |
| Header | "Model claude-sonnet-4-6" | internal | 2 | Fixed |
| Under every tab | "From your terminal: git fetch origin demo/pr-86 && git checkout FETCH_HEAD" | internal | 2 | Fixed |
| Product review | "Head e4f8a2c9 · the current head", "Reviewer reviewer-codex", proof ids in the notes | internal | 1 | Fixed |
| Checks list | Step "e2e:smoke" named by its proof id | internal | 3 | Fixed |
| State and Now | "Testing · 11m" and "Now: Testing · Mainworks is merging it." say Testing twice | twice | 2 | Open |
| Next line | "Next: Mainworks (automatic)" names no action or time | next | 2 | Open |
| Hold task button | "Hold task" sits beside the PR link with no hint of what holding does | plain | 3 | Open |
| Pipeline row | "Queued", "Test merge", "Ship" stages with no word on which one is now | plain | 3 | Open |

## A change: Live session, Lead, Details

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Live session | "No Builder has started a session on this task yet." on a task a Builder already built: false | error | 1 | Fixed |
| Lead tab | A decision filed for another task listed on this one (demo history was unfiltered) | twice | 3 | Fixed |
| Details | A bare priority picker "P0 P1 P2 P3" with no label | plain | 2 | Open |
| Details | Raw id "00000000-0000-4000-8000-000000000103" in the first row | internal | 3 | Open |
| Details | "History (2 events; routine GitHub checks and heartbeats left out)" | plain | 3 | Open |

## Lead: Conversation, Live session, History, Product

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Conversation cards | "Requirements for DEMO-105 changed" | internal | 1 | Fixed |
| Goal order rail | "DEMO-105 Export monthly invoices as CSV": keys before every goal | internal | 2 | Fixed |
| Live session | "Working · lead-claude": the agent's account id as the status | internal | 2 | Fixed |
| Product | "The master has not written the brief. It records one with master brief set FILE REASON." | internal | 1 | Fixed |
| Product (with a brief) | "Updated Nov 13 by the master." under the title, while the menu says Lead (seen in the Lead page's browser case, not the captures) | plain | 2 | Fixed |
| Empty rail and History | "No open goals.", "Nothing waits on you.", "Nothing typed into the Lead yet." with no next step | next | 2 | Fixed |
| Page fact | "Steer the Lead and act on its cards.": says how, not what state the Lead is in | next | 3 | Open |
| History | "You 10/14/2026, 8:00:00 AM" in a long US timestamp while every other page says "26m ago" | plain | 3 | Open |
| Decision card | "Why: Turned the CSV export goal into 3 checkable criteria with bound tests…": agent wording | internal | 2 | Fixed |

## Settings

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Agents | "Reading the agents…" and "Loading the agents…" at once | twice | 2 | Open |
| Workers | Task keys "DEMO-104" above each title | internal | 2 | Open |
| Workers | "0 ended." in the fact and "Ended 0" as a tab | twice | 3 | Open |
| Costs | "Reading costs…" stays with no figure when the read returns nothing to price | next | 2 | Open |
| Setup | "Master fault: acme/storefront is not onboarded. The real serve or feature map is missing." (wording pinned by the onboarding cases) | internal | 2 | Fixed |
| Setup | "Be told when the yard stops — Stall alerts: not known yet" | plain | 2 | Open |
| Delivery | "Reading the delivery settings…" stays above the settings it already shows | next | 2 | Open |
| Delivery | "Run mainworks config owner \"NAME\" EMAIL to name the owner." as the only way to change it | internal | 2 | Open |
| Help | Calls the planner "the Master" while the menu calls it Lead | plain | 2 | Fixed |
| Help | Service names "graphyard-master-OWNER-NAME.service" in the first screen | internal | 3 | Open |
| Needs you | A five-sentence paragraph above the one request | plain | 2 | Fixed |
| Needs you | "Recommended:" twice on one card, and "Signed in as owner · human operator" | twice | 3 | Open |
| Tests (empty) | "Add a case as e2e/cases/ID.json … mainworks e2e sync" as the only next step | internal | 2 | Open |

## Setup

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Checklist | "1 of 4 steps left." but four rows, one with no action button | next | 2 | Open |
| Connect step | "An agent account that writes code / reviews code": two rows a newcomer reads as two accounts to buy | plain | 2 | Open |
| Advanced folds | "Watch agents in a terminal" and "Where things run" closed with no hint of what is inside | plain | 3 | Open |

## Sign-in

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Helper text | "Operator? Run mainworks open on the Mainworks host, or mainworks login…" | internal | 2 | Open |
| Button | "Open control plane ↗": the arrow reads as a new tab, and "control plane" is builder jargon | plain | 3 | Open |
| Heading | "Keep the work moving forward." says nothing about what the product does | plain | 3 | Open |

## Empty first run

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Step 2 | "No Builder account is connected yet." with no next step in the sentence | next | 2 | Fixed |
| Step 2 | "A live request checks that your Builder account answers on its registered model" | internal | 2 | Open |
| Step 2 | "Prefer a terminal? mainworks master registry propose --apply" in the first screen | internal | 2 | Open |
| Work (empty) | "The yard is quiet. File a goal and wake the crew." then a second sentence saying the same | twice | 3 | Open |

## Error state

| Where | What a newcomer sees | Rule | Sev | Status |
|---|---|---|---|---|
| Server answered 503 | "Can't reach the control plane at 127.0.0.1:…" while the server is up and restarting: false | error | 1 | Fixed |
| Unreachable | "Can't reach the control plane at …" with no step to take beyond Retry | error | 2 | Fixed |
