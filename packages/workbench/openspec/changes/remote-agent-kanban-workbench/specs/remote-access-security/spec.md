## ADDED Requirements

### Requirement: Terminal APIs require authenticated access

The system SHALL require authenticated access before exposing card mutation,
terminal creation, terminal attach, or terminal input APIs.

#### Scenario: Unauthenticated terminal request

- **WHEN** a request without valid authentication attempts to create or attach a terminal
- **THEN** the system rejects the request
- **AND** no process is spawned

### Requirement: Commands are allowlisted by agent profile

The system SHALL spawn only commands declared in configured agent profiles.

#### Scenario: Allowed Codex profile

- **WHEN** an authorized user starts a card with the `codex` profile
- **THEN** the system starts the configured `codex` command and arguments

#### Scenario: Arbitrary command rejected

- **WHEN** a browser request attempts to start an arbitrary command string
- **THEN** the system rejects the request
- **AND** records the rejection in the audit log

### Requirement: Security-sensitive actions are audited

The system SHALL audit terminal session creation, terminal input submission,
card activation, command rejection, and authentication failures.

#### Scenario: Terminal input is submitted

- **WHEN** an authorized user sends input to a terminal session
- **THEN** the system records an audit event with timestamp, project ID, card ID, session ID, and action type
- **AND** the event does not include raw secrets or token values

