# ADR 003 · Streaming commitment

**Context.** A provider may fail after sending output. The original operation may already have incurred cost, and the client may have rendered the response.

**Alternatives.** Buffer the entire provider response, sacrificing time to first output. Replay against another provider after failure, risking duplicate or contradictory output. Use a resumable application protocol with stable semantic positions and provider support.

**Decision.** Wait for the first semantic event before writing SSE headers. Allow a bounded second attempt only before commitment and only when policy, Redis and budget authorization permit it. Once committed, send an error event when possible and terminate without `[DONE]`. Retain uncertain attempt exposure and close upstream on disconnect.

**Trade-offs and consequences.** A client can receive a partial response and must inspect completion markers. The gateway favors coherent output and per-attempt accounting. Conservative retry behavior exposes some errors that speculative replay could hide.

**Limitations.** A successful transport write does not establish client receipt. An explicit client retry creates a new potentially billable request. Resume and client idempotency require a separate contract.
