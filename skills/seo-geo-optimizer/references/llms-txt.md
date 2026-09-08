# `llms.txt` guidance

Use this reference only when creating, reviewing, or discussing `llms.txt`.

## Position it accurately

Treat `llms.txt` as a proposed, supplemental way to point language-model-oriented consumers toward useful public resources. Its adoption and behavior may vary by system and can change. Verify the current proposal and any claimed consumer support using primary sources during the task.

It is not:

- a replacement for useful, crawlable pages;
- a substitute for `robots.txt`, sitemaps, canonicals, or access controls;
- a legal permission mechanism or reliable opt-out mechanism;
- a command that controls model training or retrieval;
- a guarantee of crawling, indexing, citation, or answer inclusion.

## Source selection

Include only canonical, public, durable resources that help someone understand the product or organization. Prefer authoritative documentation, core product/service pages, policies, pricing or plan explanations, changelogs, research/methodology, and support material. Exclude private URLs, tracking variants, thin archives, duplicate locales without a clear language structure, and pages the owner cannot keep accurate.

## Conservative structure

Use a clear title, a short factual summary, optional context, and grouped Markdown links with concise descriptions. Keep the file small enough to review manually. Use absolute canonical URLs and consistent labels. Do not insert speculative claims or a dump of every sitemap URL.

Example shape:

```markdown
# Product name

> One factual sentence describing the product and audience.

## Documentation

- [Getting started](https://example.com/docs/start): What a new user can accomplish here.

## Policies

- [Privacy](https://example.com/privacy): Current privacy policy.
```

Adapt the structure to verified current guidance; the example is not a fixed standard.

## Validation

- Serve the intended path successfully with a text/Markdown-compatible content type.
- Confirm every link is public, canonical, current, and free of secrets or personalized parameters.
- Compare claims with the linked pages.
- Assign an owner and review cadence.
- Keep `robots.txt`, sitemap, metadata, and normal site architecture independently correct.
