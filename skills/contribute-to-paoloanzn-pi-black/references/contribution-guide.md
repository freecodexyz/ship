# Contribution guide

## Project rules

- Base every change on the main branch and keep one pull request to one issue.
- Report security-sensitive findings through SECURITY.md instead of a public issue or pull request.

## Verification

### Setup

- `npm ci`

### Required

- `npm run test`

## Evidence

### Implementation

- State the user-visible outcome and the exact repository checks you ran, with their results.
- Link the issue the change closes and name every file you touched.
- Report untested surfaces explicitly instead of implying coverage you did not exercise.

## Fixed boundaries

GitHub is authoritative. Refresh live state before work. Do not expose secrets, handle security-sensitive work publicly, reserve work through Ship, or treat a report candidate as acceptance or payment.
