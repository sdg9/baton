import type { AgentConfig, AgentProfile, ProjectConfig } from '../config/config';

export function resolveAgentProfile(
  agentConfig: AgentConfig,
  project: ProjectConfig,
  profileId: string
): AgentProfile {
  const profile = agentConfig.agents[profileId];
  if (!profile || !profile.allowed) {
    throw new Error(`Agent profile ${profileId} is not configured`);
  }
  if (!project.allowedAgents.includes(profileId)) {
    throw new Error(`Agent profile ${profileId} is not allowed for project ${project.id}`);
  }
  return profile;
}
