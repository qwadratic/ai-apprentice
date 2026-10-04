# Evidence timeline

`RecordingSegment` describes only finalized, ready-to-play processed recording media. Its session interval (`startMs`/`endMs`) and media interval (`mediaStartMs`/`mediaEndMs`) are milliseconds. The recorder imports the type without depending on replay UI:

```ts
import type {RecordingSegment} from '../evidence/index.js';
```

Create `new EvidenceTimeline(recorder.getSegments())` when opening Evidence. `forEvidence(ref, exactTimestampMs, sessionId)` maps that exact session-relative timestamp to a media offset. Segment intervals are half-open: an `endMs` boundary belongs to a new segment beginning there, or to a pause gap. The method returns `null` in an off-record gap; callers must show an unavailable state rather than seek to the next or previous segment.
