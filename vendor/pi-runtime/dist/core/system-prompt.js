/**
 * System prompt construction and project context loading
 */
import { APP_NAME, getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt } from "./skills.js";
/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options) {
    const { customPrompt, selectedTools, toolSnippets, promptGuidelines, appendSystemPrompt, cwd, contextFiles: providedContextFiles, skills: providedSkills, } = options;
    const promptCwd = cwd.replace(/\\/g, "/");
    const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
    const contextFiles = providedContextFiles ?? [];
    const skills = providedSkills ?? [];
    if (customPrompt) {
        let prompt = customPrompt;
        if (appendSection) {
            prompt += appendSection;
        }
        // Append project context files
        if (contextFiles.length > 0) {
            prompt += "\n\n<project_context>\n\n";
            prompt += "Project-specific instructions and guidelines:\n\n";
            for (const { path: filePath, content } of contextFiles) {
                prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
            }
            prompt += "</project_context>\n";
        }
        // Append skills section (only if read tool is available)
        const customPromptHasRead = !selectedTools || selectedTools.includes("read");
        if (customPromptHasRead && skills.length > 0) {
            prompt += formatSkillsForPrompt(skills);
        }
        prompt += `\nCurrent working directory: ${promptCwd}`;
        return prompt;
    }
    // Get absolute paths to documentation and examples
    const readmePath = getReadmePath();
    const docsPath = getDocsPath();
    const examplesPath = getExamplesPath();
    // Build tools list based on selected tools.
    // A tool appears in Available tools only when the caller provides a one-line snippet.
    const tools = selectedTools || ["read", "bash", "edit", "write"];
    const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
    const toolsList = visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
    // Build guidelines based on which tools are actually available
    const guidelinesList = [];
    const guidelinesSet = new Set();
    const addGuideline = (guideline) => {
        if (guidelinesSet.has(guideline)) {
            return;
        }
        guidelinesSet.add(guideline);
        guidelinesList.push(guideline);
    };
    const hasBash = tools.includes("bash");
    const hasGrep = tools.includes("grep");
    const hasFind = tools.includes("find");
    const hasLs = tools.includes("ls");
    const hasRead = tools.includes("read");
    // File exploration guidelines
    if (hasBash && !hasGrep && !hasFind && !hasLs) {
        addGuideline("Use bash for file operations like ls, rg, find");
    }
    for (const guideline of promptGuidelines ?? []) {
        const normalized = guideline.trim();
        if (normalized.length > 0) {
            addGuideline(normalized);
        }
    }
    // Always include these
    addGuideline("Be concise in your responses");
    addGuideline("Show file paths clearly when working with files");
    const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
    const identity = APP_NAME === "forgedock"
        ? `You are ForgeDock, a provider-neutral software delivery assistant operating inside the ForgeDock terminal.

You help users investigate issues, understand repositories, edit and test code, and review changes. GitHub artifacts are durable workflow truth. ForgeDock's typed controller—not the model—owns workflow transitions, permissions, verification gates, publication, merge, and closure. Never claim that an authoritative action completed unless controller-provided evidence confirms it.`
        : "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
    const documentationHeading = APP_NAME === "forgedock"
        ? "ForgeDock terminal implementation documentation (Pi is an internal kernel; describe it as such)"
        : "Pi documentation";
    let prompt = `${identity}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

${documentationHeading} (read only when the user asks about terminal internals, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
    if (appendSection) {
        prompt += appendSection;
    }
    // Append project context files
    if (contextFiles.length > 0) {
        prompt += "\n\n<project_context>\n\n";
        prompt += "Project-specific instructions and guidelines:\n\n";
        for (const { path: filePath, content } of contextFiles) {
            prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
        }
        prompt += "</project_context>\n";
    }
    // Append skills section (only if read tool is available)
    if (hasRead && skills.length > 0) {
        prompt += formatSkillsForPrompt(skills);
    }
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
}
//# sourceMappingURL=system-prompt.js.map