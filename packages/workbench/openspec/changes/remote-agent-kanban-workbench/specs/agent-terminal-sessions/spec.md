## ADDED Requirements

### Requirement: Card activation starts or attaches a durable terminal session

The system SHALL start or attach a tmux-backed terminal session when an
authorized user activates a card with an allowed agent profile.

#### Scenario: Start a new card session

- **WHEN** an authorized user moves a card to active work and selects `claude` or `codex`
- **THEN** the system creates a tmux session for that card if one does not already exist
- **AND** starts the selected agent command with the configured prompt context

#### Scenario: Attach existing card session

- **WHEN** an authorized user opens a card that already has a running session
- **THEN** the system attaches the browser terminal to the existing tmux session
- **AND** does not start a duplicate agent process

### Requirement: Browser terminal streams bidirectional IO

The system SHALL stream terminal output to the browser and browser input back to
the attached PTY for authorized sessions.

#### Scenario: Terminal emits output

- **WHEN** the PTY receives output from the attached tmux session
- **THEN** the browser terminal displays that output preserving terminal control sequences

#### Scenario: User submits terminal input

- **WHEN** an authorized user types into an attached browser terminal
- **THEN** the system writes that input to the PTY for the corresponding session

### Requirement: Sessions survive browser disconnects

The system SHALL keep the underlying tmux session running when the browser
disconnects.

#### Scenario: Browser disconnects during agent execution

- **WHEN** the browser connection closes while an agent session is running
- **THEN** the tmux session remains alive
- **AND** a later browser connection can attach to the same session

