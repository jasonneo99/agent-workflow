# Dashboard Enhancement Plan

## Overview
Enhance the `/agents` dashboard page to display both shared reusable agents from the repository and project-local agents from `.agent-workflow/agents`.

## API Design
- **Endpoint**: `/api/agents`
- **Method**: GET
- **Response Structure**:
  - `sharedAgents`: List of shared agent objects
  - `localAgents`: List of local project agent objects

### Agent Object
- `id`: Unique identifier
- `name`: Name of the agent
- `description`: Brief description
- `lastModified`: Timestamp of last modification

## UI Fields
- Agent Name
- Agent Description
- Last Modified Date

## Implementation Steps
1. Design API endpoint to retrieve agent data.
2. Update front-end to display new agent data fields.
3. Ensure compatibility with existing dashboard components.

## Open-Source & Local-First Approach
- Use simple JSON APIs for data retrieval.
- Store agent configurations in local files under `.agent-workflow/agents`.

## Risks
- Performance implications with large datasets.
- Complexity in merging agent data from different sources.

## Verification
- Conduct tests for API performance and correctness.
- Ensure UI displays data accurately under various scenarios.
