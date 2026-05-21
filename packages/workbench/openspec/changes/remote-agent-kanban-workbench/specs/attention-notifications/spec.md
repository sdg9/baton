## ADDED Requirements

### Requirement: Sessions can be marked as needing attention

The system SHALL detect conservative attention signals from terminal sessions
and mark the related card as needing attention.

#### Scenario: Agent exits nonzero

- **WHEN** an agent terminal process exits with a nonzero status
- **THEN** the related card is marked as needing attention
- **AND** a notification event is queued

#### Scenario: Session idle after output

- **WHEN** a session has emitted output and then remains idle longer than the configured threshold
- **THEN** the system marks the session as potentially needing attention

### Requirement: Notification delivery is pluggable

The system SHALL isolate notification delivery behind a provider interface so
macOS notifications, email, or external push providers can be added without
changing session detection logic.

#### Scenario: Notification provider configured

- **WHEN** a session queues an attention event
- **AND** a notification provider is configured
- **THEN** the system sends a notification containing the project name, card title, and session link

