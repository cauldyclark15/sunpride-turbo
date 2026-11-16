# SP-0184 release blocked on branch-history permission

The enrollment implementation and its earlier reconciliation remain on `sp/184`. Do not replay
that branch's original commits one by one: the first commit conflicts with the required-field
change now on main, before the follow-up reconciliation can run.

The supported release job consumes the lane branch, not a separate consolidated commit or mail
patch. The earlier consolidated artifact is therefore not a supported release handoff and must
not be used to claim this branch is ready for release.

The lane rules prohibit rebasing or merging and require keeping the existing branch commits.
Rebuilding `sp/184` with main as its ancestor would replace that history, even if implemented with
low-level Git commands rather than `git rebase`. Do not bypass this restriction by moving the
branch reference. JC must explicitly authorize a history replacement, with the old history kept
under a backup reference, before this release request can be completed.

## Prepared recovery, pending JC authorization

1. Preserve the existing lane tip under `backup/sp-184-pre-release-rebuild`; leave `sp/184` intact.
2. After authorization, rebuild the lane branch from the then-current main, retaining the full
   enrollment implementation, required-field/null handling, text-case tests and full-sheet guard.
   Preserve main's deployment configuration; it is not part of this feature.
3. Run the affected API, shared-field, web and Android software checks against the rebuilt source.
4. Verify the actual lane branch has main as an ancestor and every release commit replays without
   conflict in scratch, then return the issue to QA. A separate artifact is not sufficient.

The original first-commit replay was reproduced with an isolated Git index: it conflicts in the
API field-capture tests and Android screen, capture logic and capture tests. This check changes
neither the lane's working tree nor its branch history. The exact refs, proof and remaining
permission request are recorded in `/Users/jc/cnc/_plans/sunpride-lanes/sp-184-report.md`.

## Behavior retained together

- Agents fill the complete customer sheet, including tax, assignment, payment, delivery and
  applicable Channel 40 ADP fields. Offline drafts and submission retain those values.
- Required-field validation remains at both the Android Save/outbox boundary and the canonical
  server writer. Blank, whitespace and explicit JSON null values cannot bypass it.
- Customer-group applicability, nested ship-to validation, shared Android/server parity, and
  the text-case regression suite remain covered. Field-level validation is checked against the
  complete-level rules, so removing the office handoff cannot reintroduce partial submissions.
- New profiles stay pending. Scoped CDMs review and approve or reject directly without an Admin
  completion save. Agents still cannot approve or reject their submissions.

## Proof boundary

API integration tests use isolated sample databases derived from the lane configuration, not the
live database. Android build, JVM tests, lint and screen-test compilation are software-only
checks. No phones, device installs or live acceptance checks are part of this lane. A QA handoff
is not a deployment or client acceptance.
