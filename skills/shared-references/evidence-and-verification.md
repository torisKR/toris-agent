# Evidence and verification

Use this reference when a skill evaluates claims, recommends changes, or reports outcomes.

## Evidence tiers

1. **Direct measurement or repository evidence** — repeatable profiler output, build artifacts, source/config inspection, analytics exports, or supplied product facts.
2. **Current primary source** — official platform policy, framework documentation, standards text, or search-engine guidance checked during the task.
3. **Corroborated secondary source** — useful for discovery or interpretation, but not sufficient for a platform constraint when a primary source exists.
4. **Assumption or hypothesis** — explicitly labeled, paired with the evidence needed to confirm it, and never presented as a fact.

Prefer the highest available tier. Record the source, observation time when relevant, and the scope the evidence actually supports.

## Claim safety

Do not invent or amplify unsupported awards, rankings, adoption numbers, testimonials, certifications, privacy/security claims, performance results, or product capabilities. Do not promise store approval, search rankings, citations by AI systems, or measured gains before a controlled comparison.

When evidence is missing:

- use neutral, verifiable wording;
- mark the statement as an assumption or proposed hypothesis;
- identify the owner or artifact needed to verify it;
- exclude it from final submission copy if it could mislead users or reviewers.

## Before-and-after comparisons

- Keep device, build mode, data set, route, account state, network conditions, and scenario consistent.
- Separate cold and warm runs and disclose cache state.
- Run enough repetitions to show a representative median and range when measurements vary.
- Preserve correctness and accessibility gates; a faster broken flow is a regression.
- Report unfavorable or inconclusive outcomes as clearly as favorable ones.
- Attribute only the scope supported by the experiment. Multiple simultaneous changes weaken causal claims.

## Final report contract

For each important conclusion, provide:

- **Finding:** what was observed.
- **Evidence:** measurement, file, official source, or supplied fact.
- **Action:** implemented change or prioritized recommendation.
- **Verification:** how the result was checked.
- **Confidence and limits:** uncertainty, untested platforms, or missing access.
