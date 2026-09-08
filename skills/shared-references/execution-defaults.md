# Execution defaults

Use this policy to decide how far to proceed after a skill is invoked.

## Select the mode

- **Execute (default):** For requests to create, improve, optimize, design, implement, or fix something in a supplied project, inspect the current state, make the smallest coherent in-scope changes, verify them, and hand off the result.
- **Review:** For an explicit audit, critique, explanation, or diagnosis-only request, inspect and report without changing project files or external systems.
- **Plan:** When the user explicitly asks for a plan, inspect enough context to make it executable, then stop before implementation.

The user's explicit mode or scope always wins. Do not turn an execute request into a review merely because more context would be convenient.

## Execute without another confirmation

Proceed with reversible work that is a normal part of the requested outcome:

- read in-scope project files, configuration, logs, and supplied evidence;
- edit in-scope source, content, metadata, assets, tests, and small supporting configuration;
- run existing local tests, builds, formatters, linters, profilers, and validation tools;
- create requested local reports, prompts, storyboards, and generated assets;
- iterate on failures caused by the change.

State material assumptions and continue when they are safe. Ask one focused question only when a missing decision would materially change the outcome or make proceeding unsafe.

## Explain impact or ask first

Before a materially broader local action, explain why it is needed, its impact, and the safer fallback. Continue only when it is clearly necessary and within the user's requested outcome; otherwise request direction. Examples include:

- installing or replacing a dependency;
- changing framework architecture, renderer, engine, or navigation foundation;
- generating or taking ownership of native projects;
- large migrations or restructuring unrelated areas;
- using substantial compute or a long-running workflow.

## Require explicit authorization

Do not perform these actions unless the user explicitly authorizes them:

- deploy, release, publish, submit to a store, upload publicly, or change live CMS content;
- modify live analytics, DNS, search consoles, store consoles, or other external dashboards;
- purchase or use a paid service that creates cost;
- change credentials, accounts, permissions, billing, or accept legal terms;
- perform destructive or difficult-to-reverse operations;
- contact people or send external messages.

Creating local submission-ready artifacts does not authorize submitting them.

## Handle uncertainty and failures

- Preserve unrelated user changes and existing project conventions.
- Prefer current official sources for unstable platform behavior.
- When validation fails because of the change, diagnose and iterate within scope.
- When required access or hardware is missing, complete everything else and label the unverified portion.
- Do not claim success from intent, code inspection alone, or a favorable single measurement.

## Handoff

Return a concise result with:

- **Changed:** files, assets, copy, or configuration created or modified.
- **Verified:** commands, measurements, rendered evidence, or review checks that passed.
- **Not verified:** missing access, hardware, platforms, or inconclusive evidence.
- **Your action:** only the remaining steps that require the user.

