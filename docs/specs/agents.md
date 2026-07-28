## `@toris/agents` — profile + skill registry (data, not execution)

```ts
export interface AgentProfile {
  id: string;                 // e.g. 'junior-developer'
  displayName: string; category: 'dev-data'|'ops-automation'|'market-strategy'|'legal-finance'|'founder-ops'|'core';
  mission: string; role: AgentRole; defaultProfileKey: string;   // 'claude:opus' etc
  permissionMode: PermissionMode; outputs: string[]; highRiskGates: string[];
  skills: string[];
}
export const AGENT_PROFILES: readonly AgentProfile[];   // 28 founder profiles + 6 core roles
export function getProfile(id: string): AgentProfile | undefined;
export function listProfiles(category?: string): AgentProfile[];

export interface SkillDefinition { id: string; description: string; inputs: string[]; outputs: string[]; responsibility: string }
export const CORE_SKILLS: readonly SkillDefinition[];    // spec, plan, execute, review, verify, integrate, recipe
export function getSkill(id: string): SkillDefinition | undefined;
```
