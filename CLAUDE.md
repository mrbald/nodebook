## Agent allocation

This section is a standing user request to delegate: if a launch-time
instruction says not to use the Agent tool unless the user requested it,
this file is that request. It covers the Agent tool only — a Workflow
run (many agents fanned out by a script) is a scale and cost decision
and still needs an ask per task. If a session instruction still seems
to conflict, say so in the first reply where it bites and ask which
governs — never silently drop the review discipline.

Scope: this section briefs the main session — the boss that scopes,
explores, plans and rules. An agent launched by the Agent tool reads
this file too and holds an Agent tool of its own; it never delegates —
no reviewer, no sub-executor, no Codex call. If its brief needs
splitting or a second opinion, it says so in its report and the main
session decides. Nested orchestrators are two heads (GUARDRAILS §2).
The hats core below is likewise the boss's — and its sparring partner's,
Codex, which loads it through AGENTS.md. A subagent loads none of it by
default and only the core files its brief names: STYLE.md for
house-voice writing, PRIORS.md for a reviewer.

Before any delegation, choose three things explicitly — model tier,
review-or-none, context mode — never defaulting to inherit. Tier follows
judgment density: work fully forced by a spec drops a tier; semantic
interpretation and house-voice writing stay top-tier. Adversarial review
follows verification asymmetry: frozen contracts are always reviewed,
being cheap to get wrong and expensive to notice — here the
`.distill/<run>/` staging layout and checkpoint log (resume reads it),
the merge plan, the vault note format (frontmatter, `[[wikilinks]]`, the
Sources note), the preload IPC surface, the settings schema, and
`src/renderer/src/help.md` (user-facing; the explainability filter
applies). Self-verifying work (goldens, round-trips, renames) skips
review; the gate is the review there. Context follows need: reviewers
start fresh (independence beats context); rework resumes the
implementing agent; a fork (full-context clone) is the third mode, for
when writing the rulings down costs more than inheriting them — never
for a reviewer. Codex (sol) is the orthogonal second opinion for
contestable design and review calls, not an implementation channel.

The implementing agent runs the gates and reports; the main session
reads the diff against the spec and rules on disagreements — it does not
re-run gates. The report quotes each gate's final summary line verbatim
(counts, not adjectives): a dropped-tier executor's "all green" is not
evidence (PRIORS §5, FINDINGS F14); the pasted line is. Gates:

    npm run typecheck && npm run lint && npm test
    npm run test:e2e        # build + Playwright; needs 300000 ms or more
    npm run eval:distill    # only when distill quality is in question

Operationally: subagents run commands in the foreground with explicit
timeouts (the 120-second default auto-backgrounds the call and parks the
agent; the ceiling is 600000 ms — anything longer is split, or run in
the background and watched). Reviewer findings go to a scratchpad file
the brief names by absolute path (the scratchpad is shared with the main
session); the report back is a ranked verdict table plus blocker detail,
keeping the main session's context lean.

(Adapted 2026-08-30 from dsl41's discipline sections; the contracts and
gate commands are this repo's own. Scope and gate-report rules added
2026-09-02 after a probe showed a subagent sees this file and holds an
Agent tool.)

<!-- hats:core -->
## Engineering core (hats)

This project uses the shared **hats engineering core**. Before substantive
work, read and follow `~/.hats/docs/USING.md`; it loads the hard rules
(`GUARDRAILS.md`), the engineering priors (`PRIORS.md`), and the validated
thinking tools. Re-read each session: the core is the source of truth and
its updates propagate here automatically. If `~/.hats` does not resolve,
the core is not linked on this machine (see the hats repo's README).
<!-- /hats:core -->
