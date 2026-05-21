## ADDED Requirements

### Requirement: Configured projects are the only card sources

The system SHALL load cards only from explicitly configured project roots.

#### Scenario: Load OpenSpec project cards

- **WHEN** a configured project has adapter `openspec`
- **THEN** the system runs the configured OpenSpec list command from that project root
- **AND** renders returned changes as cards

#### Scenario: Reject unconfigured project path

- **WHEN** a browser request references a project path that is not configured
- **THEN** the system rejects the request
- **AND** no command is run in that path

### Requirement: OpenSpec cards map to stable board columns

The system SHALL map OpenSpec change status and local session metadata to board
columns without requiring OpenSpec files to be mutated by drag actions.

#### Scenario: In-progress OpenSpec change without active session

- **WHEN** OpenSpec reports a change as `in-progress`
- **AND** no local session exists for the card
- **THEN** the card appears in the ready or backlog-style column configured for inactive work

#### Scenario: Active session controls active column

- **WHEN** a local terminal session is running for a card
- **THEN** the card appears in an active work column regardless of raw OpenSpec task count

