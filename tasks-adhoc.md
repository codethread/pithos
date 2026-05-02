# Pithos ad hoc tracer-bullet slices

**Status:** Unimplemented
**Priority:** Process this queue before `tasks.md`.
**Scope:** Observability, diagnostics, and quick repair slices that keep the service easy to introspect.

## Slices

1. **Title:** Centralize CLI output behind an Effect service  
   **Status:** Implemented  
   **Type:** AFK  
   **Blocked by:** none  
   **Vertical slice:** Route command JSON/text emission through a shared `Output` service with live stdout/stderr sinks and test sinks that can buffer or write to temp files. Replace direct `console.log` calls in the command path so tests can silence or capture output without noisy global interception.

2. **Title:** Separate diagnostics from user-visible output  
   **Status:** Unimplemented  
   **Type:** AFK  
   **Blocked by:** 1  
   **Vertical slice:** Add a small logging boundary for structured diagnostics, using Effect logging/spans for breadcrumbs, warnings, and debug context. Keep it distinct from CLI output so command contracts stay stable while observability can be turned up on demand.

3. **Title:** Add metrics and spans for high-observability runs  
   **Status:** Unimplemented  
   **Type:** AFK  
   **Blocked by:** 1, 2  
   **Vertical slice:** Wire Effect metrics and spans into a first-class observability layer. Track command durations, task claim/heartbeat counts, stale-token failures, and sweep outcomes with OTLP-friendly composition.

4. **Title:** Capture test output deterministically  
   **Status:** Unimplemented  
   **Type:** AFK  
   **Blocked by:** 1  
   **Vertical slice:** Replace raw stdout assertions and console interception in tests with output sinks or temp-file captures. Keep Vitest output quiet unless a test explicitly opts into the captured stream.
