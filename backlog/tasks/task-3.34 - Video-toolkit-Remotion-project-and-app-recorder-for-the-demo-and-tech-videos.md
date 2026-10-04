---
id: TASK-3.34
title: 'Video toolkit: Remotion project and app recorder for the demo and tech videos'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 02:56'
labels:
  - stream-b
  - video
  - demo
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 02:57 UTC: the team must be able to make product videos (submission needs a demo video and a tech video, TASK-3.19/3.20). A standalone Remotion project in video/ (own package.json and lockfile, not a root workspace member) renders compositions from React: title and section cards in the Clipa style, captioned screen recordings, a Clipa intro, the architecture diagram from doc-11 animated. A Playwright recorder captures real runs of the product (Pages root or a local build, optionally driven by the synthetic personas of TASK-3.32) as video files that the compositions use. Renders run headless in the cloud container with the preinstalled Chromium and ffmpeg. Remotion's license is free for teams of up to 3 people; the team is 2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 npm ci && npm run render:sample in video/ renders a 10-20 s MP4 (1920x1080) headless here: title card, a captioned clip of the real app, Clipa outro
- [ ] #2 A recorder script records the product at a URL with Playwright into video/assets/ and the compositions can use the recording
- [ ] #3 Compositions take their text from a script file (no hard-coded copy), so the demo and tech video scripts (TASK-3.19) plug in
- [ ] #4 No secrets, no real personal data in renders; the README says how to render each video
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
