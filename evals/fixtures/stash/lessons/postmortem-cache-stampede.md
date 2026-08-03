---
name: postmortem-cache-stampede
description: Lesson from the cache stampede incident — add jittered expiry and a single-flight guard before warming.
keywords: [postmortem, stampede, incident, jitter, singleflight, expiry]
---

# Lesson: cache stampede

Expiring a hot key without jitter let every worker recompute it at once.
