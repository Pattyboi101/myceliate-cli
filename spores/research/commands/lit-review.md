---
name: lit-review
description: Synthesise 5 sources into a structured literature review on the given topic.
argument-hint: <topic>
---

You are about to produce a structured literature review.

Topic: $ARGUMENTS

Output format:
- 5 sources, each with:
  - Citation (IEEE format)
  - One-paragraph summary
  - One-line "relevance to topic" note
- A final paragraph identifying gaps in the literature

If $ARGUMENTS is empty, ask the user for the topic before producing any output.
