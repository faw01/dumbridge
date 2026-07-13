# Issue tracker: GitHub

Issues and specifications live in `faw01/dumbridge` GitHub Issues. Use `gh` from this clone for all operations. External pull requests are not a triage surface.

## Common operations

- Create: `gh issue create --title "..." --body-file <path>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Claim: `gh issue edit <number> --add-assignee @me`
- Resolve: comment with the answer, close the issue, then update its parent map.

## Wayfinding operations

A map is an issue labelled `wayfinder:map`. Tickets are sub-issues labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

Create all issues first, then attach tickets through GitHub's sub-issues endpoint. Express blocking with native issue dependencies using the blocker's database id. If either feature is unavailable, use a task list on the map and a `Blocked by:` line on the ticket.

The frontier is the map's open, unassigned children with no open blockers. Claim a ticket before working on it.
