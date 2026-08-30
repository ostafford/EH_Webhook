# Sensitive payroll data flows through the integration, not via EH self-setup

## Status

accepted

## Context

Employees enter all their details (including tax file number, bank account, and
superannuation) into a Connecteam onboarding pack. Employment Hero Payroll offers
a "self-setup" flow where EH emails the employee a link to enter bank / super /
tax-declaration into EH's own validated wizard, which would keep that data out of
Connecteam and out of our infrastructure.

## Decision

We do **not** use EH self-setup. The integration reads TFN, bank, and super from
Connecteam and writes them to EH via the `unstructured` employee API, so the
employee enters them exactly once. All employee-facing messaging goes through
Connecteam chat (custom publisher), never EH email.

## Consequences

- TFN and bank details are stored in Connecteam custom fields and pass through the
  Cloudflare Worker. The client is the data controller and accepts the handling
  obligations this creates (TFN Rule under the Privacy Act 1988).
- The Worker must never log or persist raw TFN / bank / super values. Queue
  messages carrying them are encrypted and short-TTL; the dead-letter queue stores
  only identifiers and error codes.
- We rely on EH's native validation (TFN check digit, BSB, super USI/ABN) to catch
  bad values, surfaced back to the employee as a Connecteam chat message.
- STP Phase 2 lodges the TFN declaration with the ATO at the first pay run, so no
  manual lodgement step is bypassed by skipping self-setup.
