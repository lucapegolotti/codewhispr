# codewhispr

## Testing strategy

We use two complementary layers of tests, both run with `npm test` (Vitest):

### Unit tests
Co-located with source files (`*.test.ts`). Test individual functions in isolation with mocked dependencies.

### Scenario tests (`src/session/scenario.test.ts`)
Integration-level tests that reproduce real bug scenarios end-to-end, using:
- A real filesystem (actual JSONL files written under `~/.claude/projects/`)
- Minimal JSONL fixture scripts derived from actual session logs
- No Telegram API, no tmux, no Claude Code process required

**Convention:** each bug fix that involves a multi-step flow should include a scenario test that reproduces the failure mode before the fix and passes after it. This prevents regressions without needing a live environment.

Scenario tests are structured as:
1. Set up filesystem state matching the bug condition (e.g. old session + new empty session after `/clear`)
2. Run the relevant primitives (`getLatestSessionFileForCwd`, `watchForResponse`, etc.)
3. Replay a minimal JSONL fixture (assistant entry + result entry from the Stop hook)
4. Assert the correct outcome (right session selected, callback fired, etc.)
