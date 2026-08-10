---
name: atlas-reasoning
description: Use openatlas to recall past reasoning before work, commit interesting steps as decision/root_cause/lesson/fix, and audit habits. Follow this protocol to make persistent reasoning memory compound across sessions.
---

# Atlas Reasoning

openatlas auto-captures every step of your sessions — you never need to make capture happen, only curate it. This protocol makes the memory useful later.

## Recall first, plan second

- At the start of a significant task, run `atlas_recall` with the task summary before planning:
  ```
  atlas_recall q="<task summary>" k=8
  ```
- Mention key files in the query, or scope recall to a file's history:
  ```
  atlas_recall file="src/foo.ts"
  atlas_recall q="port the auth middleware" file="src/auth.ts"
  ```
- Read the returned chains (steps, rootCauses, lessons, outcome) for anything that looks like the problem you are about to hit.

## Curate, don't create

Capture is automatic. Only commit the moments that matter:

- After a decision, commit it:
  ```
  atlas_commit kind="decision" content="<what and why>"
  ```
- After a bug, commit a `lesson`; when you know why, commit a `root_cause`:
  ```
  atlas_commit kind="lesson" content="<what to avoid>"
  atlas_commit kind="root_cause" content="<why it happened>"
  ```
- Link new steps to related ones so the graph compounds:
  ```
  atlas_commit kind="fix" content="<how it was fixed>" link_to="<step-id>,<step-id>"
  ```
  `link_to` creates semantic `BASED_ON` links between steps.

## Recall by file when touching code

Whenever you work on a specific file, recall by that path first — a file's history is its own argument.

## Audit yourself

- Periodically run `atlas_habits` to see your own patterns: rework (files edited 3+ times), missing tests, high error rate.
- `atlas_habits scope=general` aggregates across all projects for a broader picture.

## When unsure, recall

Recall is zero-LLM and instant — use it whenever you are unsure how something was solved before, before retrying work, and before making design decisions.
