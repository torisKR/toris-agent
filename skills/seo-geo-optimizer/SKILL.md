---
name: seo-geo-optimizer
description: Audit and improve a website's technical SEO, on-page structure, keyword and search-intent mapping, generative engine optimization (GEO), structured data, internal links, and llms.txt. Use for website launches or migrations, ranking and crawlability reviews, content architecture, keyword optimization, AI-search discoverability work, llms.txt creation, or implementing evidence-backed search improvements in a web project.
---

# SEO & GEO Optimizer

Improve how people, search engines, and answer systems discover and understand a website. Diagnose from evidence, prioritize by impact and confidence, and implement only when the user authorizes changes.

## Quick start

Read [execution defaults](../shared-references/execution-defaults.md) and select `execute`, `review`, or `plan`. In the default `execute` mode:

1. inspect the live site and repository/configuration when available, then establish goals, markets, canonical host, framework, and deployment boundary;
2. capture the technical, page, intent/keyword, entity, and provenance baseline that matches the request;
3. produce a prioritized change set and implement the smallest coherent local changes in the durable source of truth;
4. create or update `llms.txt` only when requested and appropriate;
5. validate rendered output, directives, links, structured data, and user-visible correctness without publishing or changing external consoles unless explicitly authorized.

## Operating rules

- Inspect the live site and repository/configuration when available; neither view is complete alone.
- Use current primary guidance from relevant search engines, standards bodies, and framework documentation for policies or syntax that can change.
- Treat analytics and search-console data as scoped evidence, not universal truth.
- Never use keyword stuffing, doorway pages, cloaking, fabricated expertise, fake freshness, hidden text, or mass-generated low-value pages.
- Never promise rankings, traffic, featured answers, crawling, indexing, or citation by an AI system.
- Read [evidence and verification](../shared-references/evidence-and-verification.md) before scoring findings or claiming outcomes.

## Choose the engagement

- **Audit:** inspect and report; do not modify files, CMS content, or external tools.
- **Optimize:** audit, propose a change set, implement authorized repository/CMS changes, then validate.
- **Keyword/content map:** research intent and map terms/entities to current or proposed pages without manufacturing demand data.
- **`llms.txt`:** create or review the file as a supplemental discovery aid, with explicit limitations.

Use the mode selected from the shared execution policy. An explicit audit is read-only; a create, improve, optimize, or fix request against a supplied project defaults to execution.

## Workflow

### 1. Establish goals and boundaries

Identify the business goal, conversion or information outcome, audience, markets/languages, site type, important pages, competitors supplied by the user, launch/migration history, available analytics, and mutation authorization.

Record the crawl/render environment, canonical host, framework/CMS, deployment model, and whether the live site matches the repository.

### 2. Capture a baseline

Collect only relevant evidence:

- crawl and indexation signals: status codes, redirects, robots controls, canonicals, sitemaps, pagination, alternate locales, and accidental noindex;
- rendering and discovery: server output, client-only content, navigation, internal links, orphan candidates, and important resources;
- page semantics: titles, descriptions, headings, main content, media alternatives, structured data, authorship, dates, and citations;
- experience signals: mobile layout, performance evidence, intrusive behavior, and accessibility problems that impair use or discovery;
- demand evidence: supplied query data, landing pages, conversions, geography, seasonality, and branded/non-branded separation.

Do not run an unbounded crawl or access authenticated production systems without authorization.

### 3. Build an intent and entity map

Cluster terms by user intent and topic, not superficial lexical similarity. For every cluster record audience, task, journey stage, locale, evidence source, representative terms, important entities, existing page, content gap, and desired action.

Assign one clear primary purpose per page. Consolidate overlapping pages when they compete without distinct value. Do not create a page solely to target a spelling variant or city/keyword permutation.

### 4. Evaluate technical and on-page foundations

Prioritize blockers before copy polish. Check that important URLs are reachable, render meaningful content, declare coherent canonical and locale signals, appear in appropriate navigation/sitemaps, and avoid contradictory directives.

Evaluate titles, headings, summaries, media, structured data, breadcrumbs, internal anchors, and page templates against actual content. Structured data must represent visible, truthful information and current supported vocabulary; it is not a ranking guarantee.

### 5. Improve GEO and answer readiness

GEO complements, not replaces, useful content and technical accessibility. Improve:

- explicit entity names, relationships, scope, audience, and terminology;
- direct answers followed by necessary explanation, examples, constraints, and next steps;
- source provenance, authorship, dates, methods, and primary citations where claims need them;
- stable headings, lists, tables, definitions, and self-contained passages that remain accurate when extracted;
- agreement between page copy, structured data, product facts, and linked evidence.

Do not optimize for a specific model by fabricating quotations, consensus, or citations.

### 6. Handle `llms.txt` conservatively

Read [`llms.txt` guidance](references/llms-txt.md). Confirm the user wants the file, verify current primary information about its status, and generate it from canonical, public, high-value resources. Keep it concise and maintainable.

Do not claim it overrides `robots.txt`, grants content-use permission, controls training, ensures crawling, or guarantees AI-search inclusion.

### 7. Prioritize and implement

Read [audit and deliverables](references/audit-and-deliverables.md). Rank findings by severity, evidence, reach, confidence, effort, dependency, and reversibility.

When authorized, make the smallest coherent changes that follow project conventions. Preserve analytics, accessibility, localization, legal copy, and unrelated user edits. Do not publish, deploy, submit sitemaps, change DNS, or modify external consoles unless separately authorized.

### 8. Verify

Repeat the same checks on changed pages. Validate syntax, rendered HTML, status/redirect behavior, canonical/robots consistency, structured data against current official tools or documentation, internal links, sitemap membership, locale behavior, and user-visible correctness.

Report what was measured, what was inferred, what changed, and what remains unverified. Search performance changes require observation over an appropriate period; code completion alone cannot prove ranking impact.

## Output

Deliver an executive summary, evidence and access notes, prioritized findings, keyword/intent/entity map, page-level change set, `llms.txt` when requested, implemented-file summary when authorized, validation evidence, and monitoring plan. Follow the exact tables in [audit and deliverables](references/audit-and-deliverables.md).

## Definition of done

- The requested site surfaces have an evidence-backed baseline and prioritized findings.
- Intent, keywords, entities, and target pages are mapped without invented demand data.
- Authorized local changes are implemented in the durable source of truth and documented.
- Rendered pages, technical directives, links, and structured data relevant to the change are validated.
- `llms.txt`, when requested, is accurate, canonical, and presented with its limitations.
- The handoff separates implemented results, monitoring needs, unverified impact, and any external-console action requiring the user.
