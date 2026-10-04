---
id: TASK-3.45
title: 'Clipa brand on the web app: logo, title, favicon'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 04:42'
updated_date: '2026-10-04 05:00'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: medium
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 05:05 UTC: the product is called Clipa. The web app header shows a Clipa logo (the teal paperclip mark with dot eyes, the same shape as the clipa-buddy character, and the word Clipa). The tab title becomes Clipa and the favicon is the mark.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Header shows the Clipa mark and name
- [x] #2 Document title is Clipa and the favicon is the mark
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [x] #2 Fast checks of the touched package pass; CI is green on the branch head
- [x] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #46 (b71196f), live on Pages at /clipa/. The header shows the word clipa in italic script bent from the same teal wire as the character, with no face, so it is not mistaken for Clipa herself. The tab title is Clipa; the favicon is the wire c. Root npm run check and CI green; the logo was checked as rendered PNGs (resvg).
<!-- SECTION:FINAL_SUMMARY:END -->
