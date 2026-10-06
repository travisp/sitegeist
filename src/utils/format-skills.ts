import type { Skill } from "../storage/stores/skills-store.js";

/** Tracks skill versions disclosed to one session's model context. */
export class SkillDisclosure {
	private readonly shown = new Map<string, string>();

	clear(): void {
		this.shown.clear();
	}

	format(skills: Skill[]): string {
		const newOrUpdated: Skill[] = [];
		const unchanged: Skill[] = [];
		for (const skill of skills) {
			const previous = this.shown.get(skill.name);
			if (previous === undefined || skill.lastUpdated > previous) {
				newOrUpdated.push(skill);
				this.shown.set(skill.name, skill.lastUpdated);
			} else {
				unchanged.push(skill);
			}
		}
		return formatSkills(newOrUpdated, unchanged);
	}
}

/** Full details for new versions; short references for skills already disclosed. */
function formatSkills(newOrUpdated: Skill[], unchanged: Skill[]): string {
	const sections: string[] = [];

	if (newOrUpdated.length > 0) {
		const details = newOrUpdated
			.map(
				(s) => `
<skill>
${s.name}
Domain Patterns: ${s.domainPatterns.join(", ")}
${s.description}
## Examples
\`\`\`javascript
${s.examples}
\`\`\`
</skill>
`,
			)
			.join("\n---\n");
		sections.push(`New/Updated Skills (full details):\n${details}`);
	}

	if (unchanged.length > 0) {
		const references = unchanged.map((skill) => `- ${skill.name}: ${skill.shortDescription}`).join("\n");
		sections.push(`Previously Seen Skills:\n${references}`);
	}

	return sections.length === 0 ? "none found" : sections.join("\n\n");
}
