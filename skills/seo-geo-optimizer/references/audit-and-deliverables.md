# Audit and deliverables

Use this reference for audits, implementation plans, and final reports.

## Finding record

| ID | Surface | Finding | Evidence | User/search impact | Severity | Confidence | Reach | Effort | Recommendation | Verification |
|---|---|---|---|---|---|---|---|---|---|---|

Use severity consistently:

- **Critical:** blocks discovery or creates severe user/compliance risk across important pages.
- **High:** materially prevents an important page or intent from succeeding.
- **Medium:** meaningful improvement with bounded impact.
- **Low:** polish, resilience, or a minor opportunity.

Severity is not priority by itself. Consider reach, evidence, confidence, effort, dependencies, and reversibility.

## Intent, keyword, and entity map

| Cluster | Audience and intent | Journey stage | Market/language | Evidence source | Representative terms | Entities and questions | Current target | Action | Desired outcome |
|---|---|---|---|---|---|---|---|---|---|

When reliable volume or conversion data is absent, write `not available`; do not invent estimates. Mark new-page proposals separately from updates, consolidation, and redirects.

## Page change contract

For each page provide:

- canonical URL and template/route source;
- primary audience, intent, and desired action;
- current evidence and problem;
- proposed title, description, heading/content outline, internal links, media text, and structured data changes as applicable;
- claims and citations requiring owner approval;
- implementation files or CMS fields;
- acceptance and regression checks.

## Implementation log

| File or system | Change | Reason | Risk | Validation | Rollback |
|---|---|---|---|---|---|

Do not list a proposed change as implemented.

## Final report order

1. Executive summary and top decisions
2. Scope, access, and baseline date
3. Critical/high findings
4. Intent/keyword/entity map
5. Page and technical change set
6. GEO and provenance improvements
7. `llms.txt` status when requested
8. Implemented changes and verification
9. Monitoring metrics, observation window, and ownership
10. Limitations and unverified assumptions

