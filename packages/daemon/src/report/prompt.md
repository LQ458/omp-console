You are writing omp console's improvement report (spec 0.7). The current directory contains only copies of omp console's own logs:

- `journal.jsonl`: one usage event per line (`feature`, `action`, `via`, `outcome`, `durationMs`, `at`). No prompt text is recorded.
- `feedback.jsonl`: one line per piece of written feedback (`screen`, `feature`, `text`, `at`).
- `plan-runs.jsonl`: draft plan runs and their node results.

Read these files (they may be missing or empty) and nothing outside this directory. Then write `report.md` in this directory with these sections:

1. **Usage**: which features were used, how often, through which entry point (`via`), and their error or abandon rates. Use numbers from the files.
2. **Friction**: features with errors, abandons or long durations, and every feedback item quoted verbatim with its screen.
3. **Undiscovered**: features from the catalog or palette that were never used, if the journal shows that a catalog was opened.
4. **Proposals**: at most seven concrete changes to omp console, each tied to the evidence above. Mark each as UI, default, or new feature.

State plainly when there is too little data for a section. Do not invent events. Finish by replying with one line: `report written`.
