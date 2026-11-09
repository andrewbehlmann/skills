---
name: review-with-chaired-debate
description: "Multi-agent review of a branch: independent lens reviewers, dedupe, a cross-check, and a chaired 2-round evidence debate on contested findings, then a fix round. Use when the user asks for a multi-agent review or a chaired debate, or when a big build is finished and needs its review before the PR."
---

A branch review that ends in fixed code, not a list of opinions. Independent reviewers each read the change through one **lens**. Their findings are merged, and every finding raised by only one lens is cross-checked by another. Only the **contested** findings go to a **chaired debate**: two sides, two rounds, at most 200 words per turn. **Evidence beats argument**: every claim cites `file:line`, a traced path, or a test that was run. The chair rules each one confirmed, rejected or owner's call, and every ruling is acted on.

The orchestration is `workflow.js` in this folder. Run it through the Workflow tool with `scriptPath`. Invoking this skill is the user's opt-in to that multi-agent run.

## Steps

1. **Pin the inputs** (see Inputs below).
   - Done when `git -C <worktree> diff <base>...HEAD` is non-empty and the spec is a file or a precise sentence.
   - When the change builds on an already-reviewed base, set `base` to the last reviewed commit, so only the new work is judged.
2. **Choose the lenses.**
   - The defaults are correctness, security, tests and standards.
   - Swap in lenses that fit the change. Money and Stripe suits billing; architecture suits a refactor ("did it actually deepen; replace, don't layer"). Four is the usual count.
   - Name in each lens's `focus` the specific risks you want checked hardest, such as the behavior changes a builder reported.
   - Once the lenses and each lens's focus are chosen, show them to the user (a short list: each lens and its focus in a line or two, plus the checker pairing) and ask whether they approve the selection or want revisions. Apply any revisions and show the result again.
   - Done when every lens has a key and a one-paragraph focus, every risk you listed sits in some lens, and the user has approved the selection.
3. **Run it:** `Workflow({ scriptPath: "<this folder>/workflow.js", args: {…} })`.
   - It runs in the background; wait for the notification.
   - The output file is JSON with the run's return value under `result`.
   - Save `result` as a JSON file in the scratchpad, so fix agents can read findings by id.
4. **Triage.** The result has three parts:
   - `accepted`: raised by two or more lenses, or single-source and agreed by the checker. Every one gets fixed.
   - `debated`, by ruling:
     - `confirmed`: fixed;
     - `rejected`: left alone, and the fix agents are told not to touch it;
     - `owners_call`: the chair's `safest_default` is built now and flagged to the user, never left waiting.
   - `sound`: what each lens checked and found correct. Report the main points to the user.
   - Done when every finding id has a disposition.
5. **The fix round.** Write a short fix file:
   - It points at the saved JSON by id.
   - It adds your binding decisions wherever a suggested fix is wrong, conflicts with another finding, or needs a product choice.
   - It states the checks and commit rules.

   Send it to the agent that built the code, since it knows the code. Otherwise use a fresh agent briefed with the same file.
   - Done when the agent reports every id as fixed (or explains why not), with a test for each behavior change.
6. **Verify it yourself.** Run the project's full checks on the fixed branch: typecheck, lint, the full suite twice, and the build. If the fixes were large, run a short single-agent re-review of only the fix commits.
7. **Report to the user:**
   - counts (raw, distinct, accepted, contested and each ruling);
   - every critical, high or medium finding with its fix;
   - every owner's call and the default that was built;
   - the behavior changes;
   - the check results.

## Inputs (`args`)

| Key | Meaning |
|---|---|
| `worktree` | Absolute path of the worktree holding the branch. Reviewers only read it. |
| `base` | The diff base (default `origin/main`), compared with three dots against the merge base. |
| `what` | One line naming the change, e.g. "the marketing API branch (API keys, the public catalog route)". |
| `spec` | What the change was meant to do. Binding: a path to the plan or brief plus the decisions that override it, and any builder-reported behavior changes to verify. |
| `tests` | Optional. Where reviewers may run targeted tests or read-only queries, e.g. "`npx vitest run <file>` in the worktree; its own test DB on 127.0.0.1:55322; never port 54322". Without it, reviewers run nothing that writes. |
| `standards` | Optional. Docs beyond CLAUDE.md / AGENTS.md that reviewers must hold the code to. |
| `lenses` | Optional. `[{ key, focus }]`; the defaults are in `workflow.js`. |
| `checkerOf` | Optional. `{ lensKey: checkerLensKey }`: which lens cross-checks each lens's single-source findings. By default it's the next lens in the list. Pair lenses whose risks overlap, such as correctness with money, or architecture with standards. |

## How a finding becomes contested

A finding raised by one lens goes to that lens's checker, who answers `agree`, `downgrade` (with a severity) or `disagree`, with evidence. It is **contested** when the checker disagrees, gives no answer, or rates it two or more severities lower. Everything else is accepted without debate. A run with no contested findings skips the debate; say so in the report.

## Scale

A run is about 4 reviewers, 1 merge, up to 4 checkers, and 5 agents per contested finding. That is typically 10 to 30 agents. For a small PR, one reviewer, or two reviewers and an arbiter, is the right size. Use this skill for big builds and for refactors of code that matters.
