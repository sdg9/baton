# <Capability Name>

## Purpose

<One paragraph: what this capability is responsible for. The archive
post-processor seeds this from the proposal's "Why" if you leave it as TBD,
but writing it explicitly is better.>

## Requirements

### Requirement: <Name of the contract>

<One sentence stating the contract.>

#### Scenario: <observable trigger>

- **WHEN** <external event the system observes>
- **THEN** <observable state mutation the spec requires — phrase as something
  a holdout can check end-to-end, NOT "the system MUST register X">
- **AND** <additional observable consequence, if any>

<!-- Filter test: "If I implement this scenario by exporting a pure helper
     and calling it from the holdout — but never wire the helper into any
     production dispatcher — does the scenario as written still appear
     satisfied?" If yes, rewrite as observable state transition. -->
