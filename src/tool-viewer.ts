/**
 * Tool Viewer — introspects Claude Code configuration to show all tools,
 * skills, commands, MCP servers, hooks, permissions, and env vars.
 * Distinguishes global vs project-level scope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { renderMarkdownInline } from "./markdown.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandInfo {
  name: string;
  description: string;
  content: string;
  scope: "global" | "project";
  project?: string;
  path: string;
}

interface AgentInfo {
  name: string;
  description: string;
  tools: string;
  model: string;
  content: string;
  scope: "global" | "project";
  project?: string;
  path: string;
}

interface SkillInfo {
  name: string;
  description: string;
  oneLiner: string;
  triggers: string[];
  content: string;
  scope: "global" | "project";
  project?: string;
  path: string;
}

interface McpServerInfo {
  name: string;
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  scope: "global" | "project";
  project?: string;
  source: "settings" | "plugin";
  enabled: boolean;
  appSource?: string;
  /** Which projects have this server in their permissions allow-list */
  allowedInProjects?: string[];
}

interface PluginInfo {
  name: string;
  description: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  installedAt: string;
  lastUpdated: string;
}

interface MemoryFile {
  name: string;
  description: string;
  type: string; // user, feedback, project, reference
  project: string;
  content: string;
  path: string;
}

interface HookInfo {
  event: string;
  type: string;
  command: string;
  scope: "global" | "project";
  project?: string;
}

interface ToolViewerData {
  commands: CommandInfo[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  mcpServers: McpServerInfo[];
  plugins: PluginInfo[];
  hooks: HookInfo[];
  permissions: string[];
  envVars: Record<string, string>;
  settings: Record<string, unknown>;
  /** Per-project MCP permission lists: project name -> allowed mcp names */
  projectMcpPermissions: Map<string, string[]>;
  /** Which projects have each MCP server in their .mcp.json: server name -> project names */
  mcpProjectUsage: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

function readJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function parseSkillMd(content: string): { name?: string; description?: string; oneLiner?: string; triggers?: string[] } {
  const result: { name?: string; description?: string; oneLiner?: string; triggers?: string[] } = {};
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;
  const fm = fmMatch[1];

  const nameMatch = fm.match(/^name:\s*"?(.+?)"?\s*$/m);
  if (nameMatch) result.name = nameMatch[1];

  const descMatch = fm.match(/^description:\s*"?(.+?)"?\s*$/m);
  if (descMatch) result.description = descMatch[1];

  const oneMatch = fm.match(/^one_liner:\s*"?(.+?)"?\s*$/m);
  if (oneMatch) result.oneLiner = oneMatch[1];

  const triggerSection = fm.match(/activation_triggers:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (triggerSection) {
    result.triggers = triggerSection[1]
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*"?/, "").replace(/"?\s*$/, ""))
      .filter(Boolean);
  }

  return result;
}

function parseCommandMd(content: string): { description?: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return { description: descMatch[1].trim() };
  }
  const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  return { description: lines[0]?.trim() ?? "" };
}

/** Strip YAML frontmatter from markdown content for display. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

function scanCommands(dir: string, scope: "global" | "project", project?: string): CommandInfo[] {
  const results: CommandInfo[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseCommandMd(raw);
      results.push({
        name: file.replace(/\.md$/, ""),
        description: parsed.description ?? "",
        content: stripFrontmatter(raw),
        scope,
        project,
        path: filePath,
      });
    }
  } catch { /* skip */ }
  return results;
}

function scanSkills(dir: string, scope: "global" | "project", project?: string): SkillInfo[] {
  const results: SkillInfo[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const skillFile = path.join(dir, d.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const raw = fs.readFileSync(skillFile, "utf-8");
      const parsed = parseSkillMd(raw);
      results.push({
        name: parsed.name ?? d.name,
        description: parsed.description ?? "",
        oneLiner: parsed.oneLiner ?? "",
        triggers: parsed.triggers ?? [],
        content: stripFrontmatter(raw),
        scope,
        project,
        path: skillFile,
      });
    }
  } catch { /* skip */ }
  return results;
}

function parseAgentMd(content: string): { name?: string; description?: string; tools?: string; model?: string } {
  const result: { name?: string; description?: string; tools?: string; model?: string } = {};
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*"?(.+?)"?\s*$/m);
  if (nameMatch) result.name = nameMatch[1];
  const descMatch = fm.match(/^description:\s*"?(.+?)"?\s*$/m);
  if (descMatch) result.description = descMatch[1];
  const toolsMatch = fm.match(/^tools:\s*(.+)$/m);
  if (toolsMatch) result.tools = toolsMatch[1].trim();
  const modelMatch = fm.match(/^model:\s*(.+)$/m);
  if (modelMatch) result.model = modelMatch[1].trim();
  return result;
}

function scanAgents(dir: string, scope: "global" | "project", project?: string): AgentInfo[] {
  const results: AgentInfo[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseAgentMd(raw);
      results.push({
        name: parsed.name ?? file.replace(/\.md$/, ""),
        description: parsed.description ?? "",
        tools: parsed.tools ?? "",
        model: parsed.model ?? "inherit",
        content: stripFrontmatter(raw),
        scope,
        project,
        path: filePath,
      });
    }
  } catch { /* skip */ }
  return results;
}

function scanMcpFromSettings(settingsPath: string, scope: "global" | "project", project?: string): McpServerInfo[] {
  const results: McpServerInfo[] = [];
  const settings = readJsonSafe(settingsPath) as Record<string, unknown> | null;
  if (!settings || !settings.mcpServers) return results;
  const servers = settings.mcpServers as Record<string, Record<string, unknown>>;
  for (const [name, config] of Object.entries(servers)) {
    results.push({
      name,
      type: (config.type as string) ?? (config.command ? "stdio" : "unknown"),
      url: config.url as string | undefined,
      command: config.command as string | undefined,
      args: config.args as string[] | undefined,
      scope,
      project,
      source: "settings",
      enabled: config.disabled !== true,
    });
  }
  return results;
}

function scanPlugins(claudeDir: string): { plugins: PluginInfo[]; mcpServers: McpServerInfo[] } {
  const plugins: PluginInfo[] = [];
  const mcpServers: McpServerInfo[] = [];

  const installedPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  const installed = readJsonSafe(installedPath) as { plugins?: Record<string, Array<Record<string, unknown>>> } | null;
  if (!installed?.plugins) return { plugins, mcpServers };

  const settingsPath = path.join(claudeDir, "settings.json");
  const settings = readJsonSafe(settingsPath) as Record<string, unknown> | null;
  const enabledPlugins = (settings?.enabledPlugins ?? {}) as Record<string, boolean>;

  for (const [fullName, versions] of Object.entries(installed.plugins)) {
    const latest = versions[0];
    if (!latest) continue;
    const [pluginName, marketplace] = fullName.split("@");
    const enabled = enabledPlugins[fullName] ?? false;

    const pluginJsonPath = path.join(latest.installPath as string, ".claude-plugin", "plugin.json");
    const pluginMeta = readJsonSafe(pluginJsonPath) as Record<string, unknown> | null;

    plugins.push({
      name: pluginName,
      description: (pluginMeta?.description as string) ?? "",
      marketplace: marketplace ?? "",
      version: (latest.version as string) ?? "",
      enabled,
      installedAt: (latest.installedAt as string) ?? "",
      lastUpdated: (latest.lastUpdated as string) ?? "",
    });

    const mcpJsonPath = path.join(latest.installPath as string, ".mcp.json");
    const mcpConfig = readJsonSafe(mcpJsonPath) as Record<string, Record<string, unknown>> | null;
    if (mcpConfig) {
      for (const [serverName, config] of Object.entries(mcpConfig)) {
        mcpServers.push({
          name: serverName,
          type: (config.type as string) ?? (config.command ? "stdio" : "unknown"),
          url: config.url as string | undefined,
          command: config.command as string | undefined,
          args: config.args as string[] | undefined,
          scope: "global",
          source: "plugin",
          enabled,
        });
      }
    }
  }

  return { plugins, mcpServers };
}

/**
 * Scan all MCP servers by reading config files directly.
 * Sources:
 *   ~/.claude.json → mcpServers (user scope, available in all projects)
 *   ~/.claude.json → projects.<path>.mcpServers (local scope, per-project)
 *   <project>/.mcp.json → mcpServers (project scope, shared via version control)
 *   <project>/.claude/mcp.json → mcpServers (project scope, local)
 * Returns servers with scope info and project mapping.
 */
function scanAllMcpServers(): { servers: McpServerInfo[]; projectUsage: Map<string, string[]> } {
  const servers: McpServerInfo[] = [];
  const projectUsage = new Map<string, string[]>();
  const seen = new Map<string, McpServerInfo>(); // name → first server entry

  function addServer(s: McpServerInfo, projects?: string[]) {
    if (!seen.has(s.name)) {
      seen.set(s.name, s);
      servers.push(s);
    }
    if (projects) {
      const existing = projectUsage.get(s.name) ?? [];
      for (const p of projects) {
        if (!existing.includes(p)) existing.push(p);
      }
      projectUsage.set(s.name, existing);
    }
  }

  function parseServerConfig(name: string, config: Record<string, unknown>): Omit<McpServerInfo, "scope" | "source" | "enabled"> {
    const hasUrl = !!config.url;
    return {
      name,
      type: (config.type as string) ?? (hasUrl ? "http" : config.command ? "stdio" : "unknown"),
      url: config.url as string | undefined,
      command: config.command as string | undefined,
      args: config.args as string[] | undefined,
    };
  }

  // 1. Read ~/.claude.json
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  const claudeJson = readJsonSafe(claudeJsonPath) as Record<string, unknown> | null;

  if (claudeJson) {
    // User-scoped servers
    const userServers = (claudeJson.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, config] of Object.entries(userServers)) {
      addServer({
        ...parseServerConfig(name, config),
        scope: "global",
        source: "settings",
        enabled: true,
        appSource: "User (all projects)",
      });
    }

    // Local-scoped servers per project
    const projects = (claudeJson.projects ?? {}) as Record<string, Record<string, unknown>>;
    for (const [projPath, projData] of Object.entries(projects)) {
      if (!projData || typeof projData !== "object") continue;
      const projServers = (projData.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      if (!Object.keys(projServers).length) continue;
      const projName = path.basename(projPath);
      for (const [name, config] of Object.entries(projServers)) {
        if (!config || typeof config !== "object" || !Object.keys(config).length) continue;
        addServer({
          ...parseServerConfig(name, config),
          scope: "project",
          source: "settings",
          enabled: true,
          appSource: "Local (per-project)",
        }, [projName]);
      }
    }
  }

  return { servers, projectUsage };
}

function scanHooks(settingsPath: string, scope: "global" | "project", project?: string): HookInfo[] {
  const results: HookInfo[] = [];
  const settings = readJsonSafe(settingsPath) as Record<string, unknown> | null;
  if (!settings?.hooks) return results;
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
  for (const [event, configs] of Object.entries(hooks)) {
    for (const config of configs) {
      if (!config.hooks) continue;
      for (const hook of config.hooks) {
        results.push({
          event,
          type: hook.type ?? "command",
          command: hook.command ?? "",
          scope,
          project,
        });
      }
    }
  }
  return results;
}

/** Scan .mcp.json in a project directory for project-scoped MCP servers. */
function scanMcpJsonFile(filePath: string, project: string): McpServerInfo[] {
  const results: McpServerInfo[] = [];
  const data = readJsonSafe(filePath) as { mcpServers?: Record<string, Record<string, unknown>> } | null;
  if (!data?.mcpServers) return results;
  for (const [name, config] of Object.entries(data.mcpServers)) {
    results.push({
      name,
      type: (config.type as string) ?? (config.command ? "stdio" : config.url ? "http" : "unknown"),
      url: config.url as string | undefined,
      command: config.command as string | undefined,
      args: config.args as string[] | undefined,
      scope: "project",
      project,
      source: "settings",
      enabled: true,
    });
  }
  return results;
}

/** Scan memory files from all project memory directories. */
function scanMemoryFiles(): MemoryFile[] {
  const results: MemoryFile[] = [];
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return results;

  try {
    const projDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const d of projDirs) {
      const memDir = path.join(projectsDir, d.name, "memory");
      if (!fs.existsSync(memDir)) continue;
      const projName = decodeProjectDir(d.name);

      const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const filePath = path.join(memDir, file);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          let name = file.replace(/\.md$/, "");
          let description = "";
          let type = "project";
          if (fmMatch) {
            const fm = fmMatch[1];
            const nameMatch = fm.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            const descMatch = fm.match(/^description:\s*(.+)$/m);
            if (descMatch) description = descMatch[1].trim();
            const typeMatch = fm.match(/^type:\s*(.+)$/m);
            if (typeMatch) type = typeMatch[1].trim();
          }
          results.push({
            name,
            description,
            type,
            project: projName,
            content: stripFrontmatter(raw),
            path: filePath,
          });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return results;
}

/** Extract MCP permission names from a settings.json file. */
function getMcpPermissions(settingsPath: string): string[] {
  const settings = readJsonSafe(settingsPath) as Record<string, unknown> | null;
  if (!settings?.permissions) return [];
  const perms = settings.permissions as { allow?: string[] };
  return (perms.allow ?? []).filter((p) => p.startsWith("mcp__"));
}

export function scanToolConfig(): ToolViewerData {
  const claudeDir = path.join(os.homedir(), ".claude");
  const globalSettingsPath = path.join(claudeDir, "settings.json");
  const globalSettings = readJsonSafe(globalSettingsPath) as Record<string, unknown> | null;

  const commands = scanCommands(path.join(claudeDir, "commands"), "global");
  const skills = scanSkills(path.join(claudeDir, "skills"), "global");
  const agents = scanAgents(path.join(claudeDir, "agents"), "global");

  // MCP servers — read directly from config files (instant, no CLI dependency)
  const { servers: mcpServers, projectUsage: mcpProjectUsageFromConfig } = scanAllMcpServers();

  // Also scan Claude Desktop config
  const desktopConfigPath = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const desktopMcp = scanMcpFromSettings(desktopConfigPath, "global");
  for (const s of desktopMcp) {
    s.source = "settings";
    s.appSource = "Claude Desktop";
    if (!mcpServers.some((m) => m.name === s.name)) mcpServers.push(s);
  }

  const { plugins } = scanPlugins(claudeDir);

  const hooks = scanHooks(globalSettingsPath, "global");

  const permissions: string[] = [];
  if (globalSettings?.permissions) {
    const perms = globalSettings.permissions as { allow?: string[] };
    if (perms.allow) permissions.push(...perms.allow);
  }

  const envVars = (globalSettings?.env as Record<string, string>) ?? {};

  // Per-project MCP permissions
  const projectMcpPermissions = new Map<string, string[]>();

  /** Skip worktree dirs, temp review branches, and other ephemeral directories. */
  function isEphemeralProject(name: string): boolean {
    if (/^agent-/.test(name)) return true;
    if (name.startsWith(".")) return true;
    if (/-review-\d+$/.test(name) || /-pr-review-\d+$/.test(name)) return true;
    if (/^think-tank-.+-\d{8}-[a-f0-9]{4}$/.test(name)) return true;
    return false;
  }

  /** Check if a directory is a git worktree (has .git as a file, not a directory). */
  function isGitWorktree(dirPath: string): boolean {
    try {
      const gitPath = path.join(dirPath, ".git");
      const stat = fs.statSync(gitPath);
      return stat.isFile(); // worktrees have .git as a file pointing to the main repo
    } catch {
      return false;
    }
  }

  // Scan project directories
  const projectsDir = path.join(claudeDir, "projects");
  if (fs.existsSync(projectsDir)) {
    try {
      const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const d of projectDirs) {
        const projDir = path.join(projectsDir, d.name);
        const projName = decodeProjectDir(d.name);

        // Skip ephemeral/worktree/temp projects
        if (isEphemeralProject(projName)) continue;
        // Skip orchid runner temp dirs (decoded as "ori/orchid-*")
        if (projName.startsWith("ori/orchid")) continue;

        const projSettings = path.join(projDir, "settings.json");
        const projSettingsLocal = path.join(projDir, "settings.local.json");
        mcpServers.push(...scanMcpFromSettings(projSettings, "project", projName));
        mcpServers.push(...scanMcpFromSettings(projSettingsLocal, "project", projName));
        hooks.push(...scanHooks(projSettings, "project", projName));

        // Collect project-level MCP permissions
        const projPerms = getMcpPermissions(projSettings);
        if (projPerms.length > 0) {
          projectMcpPermissions.set(projName, projPerms);
        }

        commands.push(...scanCommands(path.join(projDir, "commands"), "project", projName));
        skills.push(...scanSkills(path.join(projDir, "skills"), "project", projName));
        agents.push(...scanAgents(path.join(projDir, "agents"), "project", projName));
      }
    } catch { /* skip */ }
  }

  // Scan actual project directories for .claude/commands/, .claude/skills/, and .mcp.json
  // Derive real project paths from ~/.claude/projects/ encoded dir names
  const existingCmdPaths = new Set(commands.map((c) => c.path));
  const existingSkillPaths = new Set(skills.map((s) => s.path));
  const existingAgentPaths = new Set(agents.map((a) => a.path));
  const scannedRealPaths = new Set<string>();
  /** Track which projects use each MCP server — seed from ~/.claude.json scan. */
  const mcpProjectUsage = new Map<string, string[]>();
  for (const [name, projects] of mcpProjectUsageFromConfig) {
    mcpProjectUsage.set(name, [...projects]);
  }

  if (fs.existsSync(projectsDir)) {
    try {
      const metaDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const d of metaDirs) {
        const realPath = decodeProjectPath(d.name);
        if (!realPath || scannedRealPaths.has(realPath)) continue;
        scannedRealPaths.add(realPath);

        const projName = path.basename(realPath);
        if (isEphemeralProject(projName)) continue;
        if (isGitWorktree(realPath)) continue;

        // Scan .mcp.json for project-scoped MCP servers
        const mcpJsonPath = path.join(realPath, ".mcp.json");
        if (fs.existsSync(mcpJsonPath)) {
          const projMcp = scanMcpJsonFile(mcpJsonPath, projName);
          for (const s of projMcp) {
            if (!mcpProjectUsage.has(s.name)) mcpProjectUsage.set(s.name, []);
            mcpProjectUsage.get(s.name)!.push(projName);
          }
          // Add servers not already known from the CLI scan
          const knownNames = new Set(mcpServers.map((m) => m.name));
          for (const s of projMcp) {
            if (!knownNames.has(s.name)) {
              mcpServers.push(s);
              knownNames.add(s.name);
            }
          }
        }

        const projClaude = path.join(realPath, ".claude");
        if (!fs.existsSync(projClaude)) continue;

        const projCmds = scanCommands(path.join(projClaude, "commands"), "project", projName);
        for (const c of projCmds) {
          if (!existingCmdPaths.has(c.path)) {
            commands.push(c);
            existingCmdPaths.add(c.path);
          }
        }
        const projSkills = scanSkills(path.join(projClaude, "skills"), "project", projName);
        for (const s of projSkills) {
          if (!existingSkillPaths.has(s.path)) {
            skills.push(s);
            existingSkillPaths.add(s.path);
          }
        }
        const projAgents = scanAgents(path.join(projClaude, "agents"), "project", projName);
        for (const a of projAgents) {
          if (!existingAgentPaths.has(a.path)) {
            agents.push(a);
            existingAgentPaths.add(a.path);
          }
        }
      }
    } catch { /* skip */ }
  }

  const displaySettings: Record<string, unknown> = {};
  if (globalSettings) {
    for (const [k, v] of Object.entries(globalSettings)) {
      if (!["hooks", "permissions", "env", "mcpServers", "enabledPlugins"].includes(k)) {
        displaySettings[k] = v;
      }
    }
  }

  return {
    commands,
    skills,
    agents,
    mcpServers,
    plugins,
    hooks,
    permissions,
    envVars,
    settings: displaySettings,
    projectMcpPermissions,
    mcpProjectUsage,
  };
}

function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  const stripped = encoded.slice(1);
  const knownPrefixes = [
    /^Users-(.+?)-Documents-Programs-/,
    /^Users-(.+?)-Documents-/,
    /^Users-([^-]+)-/,
  ];
  for (const re of knownPrefixes) {
    const m = stripped.match(re);
    if (m) {
      const rest = stripped.slice(m[0].length);
      return rest || stripped;
    }
  }
  return stripped;
}

/**
 * Reconstruct the real filesystem path from an encoded ~/.claude/projects/ dir name.
 * e.g. "-Users-david-Documents-Programs-convo-viewer" → "/Users/david/Documents/Programs/convo-viewer"
 *
 * The encoding replaces "/" with "-" and prepends "-". Since "-" is ambiguous,
 * we try the full path reconstruction and verify it exists on disk.
 */
export function decodeProjectPath(encoded: string): string | null {
  if (!encoded.startsWith("-")) return null;
  // The encoded name is the full path with "/" replaced by "-" and a leading "-"
  // Try to reconstruct by replacing "-" back with "/" and checking if the path exists
  const stripped = encoded.slice(1); // remove leading -

  // Try progressively: the path starts with a known root
  // Common roots: /Users, /home, /private/tmp, /var, etc.
  const roots = ["Users", "home", "private", "var", "tmp", "opt"];
  const firstSeg = stripped.split("-")[0];
  if (!roots.includes(firstSeg)) return null;

  // Reconstruct by trying each "-" as either "/" or literal "-"
  // Optimization: known structure is /<root>/<user>/.../<project>
  // Try the simple approach: replace all "-" with "/" and check if path exists,
  // then progressively merge segments to handle dirs with hyphens in their names.
  const segments = stripped.split("-");
  return findValidPath("/" + segments[0], segments, 1);
}

function findValidPath(current: string, segments: string[], idx: number): string | null {
  if (idx >= segments.length) {
    try { fs.statSync(current); return current; } catch { return null; }
  }

  // Try "/" first (path separator) — only if current path exists as a directory
  try {
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const asDir = current + "/" + segments[idx];
      const dirResult = findValidPath(asDir, segments, idx + 1);
      if (dirResult) return dirResult;
    }
  } catch { /* current doesn't exist as dir, skip */ }

  // Try "-" (literal hyphen in name)
  const asHyphen = current + "-" + segments[idx];
  return findValidPath(asHyphen, segments, idx + 1);
}

// ---------------------------------------------------------------------------
// Known descriptions
// ---------------------------------------------------------------------------

const SETTING_DESCRIPTIONS: Record<string, string> = {
  cleanupPeriodDays: "How many days before old session data is cleaned up",
  alwaysThinkingEnabled: "When on, Claude always uses extended thinking regardless of prompt complexity",
  effortLevel: "Controls how much effort Claude puts into responses (low, medium, high)",
  skipDangerousModePermissionPrompt: "Skip the confirmation prompt when entering dangerous/bypass permission mode",
  statusLine: "Command that generates the status bar content shown in the Claude Code CLI",
};

const ENV_DESCRIPTIONS: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "Enables experimental agent teams feature for parallel multi-agent work",
  ANTHROPIC_API_KEY: "API key for Anthropic Claude API access",
  CLAUDE_CODE_MAX_TOKENS: "Maximum token limit for Claude responses",
  MAX_MCP_OUTPUT_TOKENS: "Maximum tokens allowed in MCP tool output responses",
  ENABLE_EXPERIMENTAL_MCP_CLI: "Enables experimental MCP CLI features",
};

// ---------------------------------------------------------------------------
// HTML Builder
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escape for embedding in a JS string inside a script. */
function escJs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "").replace(/<\//g, "<\\/");
}

/** Group items by prefix (e.g. "sage-review" → "sage", "draft-commit" → standalone). */
function groupByPrefix<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const dash = item.name.indexOf("-");
    const prefix = dash > 0 ? item.name.slice(0, dash) : "__standalone__";
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(item);
  }
  // Move single-item groups into standalone
  const standalone = groups.get("__standalone__") ?? [];
  for (const [prefix, items] of groups) {
    if (prefix !== "__standalone__" && items.length === 1) {
      standalone.push(...items);
      groups.delete(prefix);
    }
  }
  if (standalone.length > 0) groups.set("__standalone__", standalone);
  return groups;
}

/** Capitalize a prefix for display: "sage" → "Sage", "gloss" → "Gloss". */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildMemoryPage(): string {
  const memories = scanMemoryFiles();

  // Group by project
  const byProject = new Map<string, MemoryFile[]>();
  for (const m of memories) {
    if (!byProject.has(m.project)) byProject.set(m.project, []);
    byProject.get(m.project)!.push(m);
  }
  // Sort projects by memory count desc
  const sortedProjects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length);

  // Pre-render content
  const allDetails: Record<string, string> = {};
  for (const m of memories) {
    allDetails[m.project + "|" + m.name] = renderMarkdownInline(m.content.slice(0, 4000));
  }

  // Type badge colors
  const typeColors: Record<string, { bg: string; fg: string }> = {
    user: { bg: "var(--blue-bg, rgba(88,166,255,0.1))", fg: "var(--blue, #58a6ff)" },
    feedback: { bg: "var(--purple-bg, rgba(188,140,255,0.1))", fg: "var(--purple, #bc8cff)" },
    project: { bg: "var(--green-bg, rgba(63,185,80,0.1))", fg: "var(--green, #3fb950)" },
    reference: { bg: "var(--yellow-bg, rgba(210,153,34,0.1))", fg: "var(--yellow, #d29922)" },
  };

  let memoryHtml = `<input class="tab-search" type="text" placeholder="Filter memories..." oninput="filterRows(this, 'memory-content')">`;
  memoryHtml += `<div id="memory-content">`;

  for (const [proj, mems] of sortedProjects) {
    // Sort: MEMORY.md pinned to top, then alphabetically by name
    mems.sort((a, b) => {
      const aIsIndex = a.name === "MEMORY";
      const bIsIndex = b.name === "MEMORY";
      if (aIsIndex && !bIsIndex) return -1;
      if (!aIsIndex && bIsIndex) return 1;
      return a.name.localeCompare(b.name);
    });
    memoryHtml += `<div class="skill-group"><div class="group-label">${esc(proj)}<span class="group-count">${mems.length}</span></div>`;
    memoryHtml += `<div class="skill-list">`;
    for (const m of mems) {
      const key = m.project + "|" + m.name;
      const tc = typeColors[m.type] ?? typeColors.project;
      memoryHtml += `
      <div class="skill-row" onclick="toggleDetail('${escJs(key)}')" data-name="${esc(m.name + " " + m.project)}" data-desc="${esc(m.description)}">
        <span class="skill-name">${esc(m.name)}</span>
        <span class="skill-desc">${esc(m.description)}</span>
        <span class="skill-badges">
          <span class="meta-chip" style="background:${tc.bg};color:${tc.fg}">${esc(m.type)}</span>
        </span>
        <span class="skill-chevron">\u25B6</span>
      </div>
      <div class="skill-detail" id="detail-${esc(key.replace(/[^a-zA-Z0-9]/g, "_"))}"></div>`;
    }
    memoryHtml += `</div></div>`;
  }
  memoryHtml += `</div>`;

  if (memories.length === 0) {
    memoryHtml = '<div class="empty-state">No memory files found</div>';
  }

  // Reuse the same page shell as the tool viewer
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gloss — Memory</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --text: #e6edf3; --text2: #7d8590; --border: #30363d;
    --accent: #da7756; --accent2: #da775620;
    --green: #3fb950; --green-bg: rgba(63, 185, 80, 0.1);
    --blue: #58a6ff; --blue-bg: rgba(88, 166, 255, 0.1);
    --purple: #bc8cff; --purple-bg: rgba(188, 140, 255, 0.1);
    --yellow: #d29922; --yellow-bg: rgba(210, 153, 34, 0.1);
    --cyan: #39d2c0; --cyan-bg: rgba(57, 210, 192, 0.1);
  }
  @media (prefers-color-scheme: light) { :root {
    --bg: #f6f8fa; --surface: #ffffff; --surface2: #f0f2f5;
    --text: #1f2328; --text2: #656d76; --border: #d0d7de;
    --accent: #c2613a; --accent2: #c2613a15;
    --green: #1a7f37; --green-bg: rgba(26, 127, 55, 0.08);
    --blue: #0969da; --blue-bg: rgba(9, 105, 218, 0.08);
    --purple: #8250df; --purple-bg: rgba(130, 80, 223, 0.08);
    --yellow: #9a6700; --yellow-bg: rgba(154, 103, 0, 0.08);
    --cyan: #0d9488; --cyan-bg: rgba(13, 148, 136, 0.08);
  }}
  [data-theme="light"] {
    --bg: #f6f8fa; --surface: #ffffff; --surface2: #f0f2f5;
    --text: #1f2328; --text2: #656d76; --border: #d0d7de;
    --accent: #c2613a; --accent2: #c2613a15;
    --green: #1a7f37; --green-bg: rgba(26, 127, 55, 0.08);
    --blue: #0969da; --blue-bg: rgba(9, 105, 218, 0.08);
    --purple: #8250df; --purple-bg: rgba(130, 80, 223, 0.08);
    --yellow: #9a6700; --yellow-bg: rgba(154, 103, 0, 0.08);
    --cyan: #0d9488; --cyan-bg: rgba(13, 148, 136, 0.08);
  }
  [data-theme="dark"] {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --text: #e6edf3; --text2: #7d8590; --border: #30363d;
    --accent: #da7756; --accent2: #da775620;
    --green: #3fb950; --green-bg: rgba(63, 185, 80, 0.1);
    --blue: #58a6ff; --blue-bg: rgba(88, 166, 255, 0.1);
    --purple: #bc8cff; --purple-bg: rgba(188, 140, 255, 0.1);
    --yellow: #d29922; --yellow-bg: rgba(210, 153, 34, 0.1);
    --cyan: #39d2c0; --cyan-bg: rgba(57, 210, 192, 0.1);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 32px 24px; max-width: 1100px; margin: 0 auto;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .page-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .page-header h1 { font-size: 1.4rem; font-weight: 600; }
  .top-nav { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .top-nav-tab {
    padding: 8px 16px 8px 0; margin-right: 8px;
    font-size: 0.85rem; font-weight: 500;
    color: var(--text2); text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .top-nav-tab:hover { color: var(--text); text-decoration: none; }
  .top-nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .section-desc { font-size: 0.8rem; color: var(--text2); margin-bottom: 16px; line-height: 1.4; }
  .tab-search {
    width: 100%; padding: 8px 12px; margin-bottom: 16px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); font-size: 0.85rem; outline: none; font-family: inherit;
  }
  .tab-search:focus { border-color: var(--accent); }
  .skill-group { margin-bottom: 20px; }
  .group-label {
    font-size: 0.82rem; font-weight: 600; color: var(--text);
    margin-bottom: 4px; padding: 4px 0; display: flex; align-items: center; gap: 8px;
  }
  .group-count {
    font-size: 0.68rem; background: var(--surface2); color: var(--text2);
    padding: 1px 6px; border-radius: 10px; font-weight: 500;
  }
  .skill-list {
    background: var(--border); border-radius: 8px; overflow: hidden;
    display: flex; flex-direction: column; gap: 1px;
  }
  .skill-row {
    display: grid; grid-template-columns: 200px 1fr auto 16px;
    gap: 12px; align-items: center; padding: 10px 14px;
    background: var(--surface); cursor: pointer; transition: background 0.1s;
  }
  .skill-row:hover { background: var(--surface2); }
  .skill-name { font-size: 0.85rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .skill-desc { font-size: 0.8rem; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .skill-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
  .skill-chevron { color: var(--text2); font-size: 0.6rem; transition: transform 0.15s; flex-shrink: 0; }
  .meta-chip {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 4px;
    background: var(--surface2); color: var(--text2);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .skill-detail {
    display: none; padding: 16px 20px; background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 0.82rem; line-height: 1.6; color: var(--text);
    max-height: 400px; overflow-y: auto;
  }
  .skill-detail.open { display: block; }
  .skill-detail h1, .skill-detail h2, .skill-detail h3, .skill-detail h4 { font-weight: 600; margin: 12px 0 6px; }
  .skill-detail h1 { font-size: 1.1rem; } .skill-detail h2 { font-size: 0.95rem; } .skill-detail h3 { font-size: 0.88rem; }
  .skill-detail p { margin: 6px 0; }
  .skill-detail ul, .skill-detail ol { margin: 6px 0; padding-left: 20px; }
  .skill-detail li { margin: 2px 0; }
  .skill-detail code { font-family: 'SF Mono','Fira Code',monospace; font-size: 0.78rem; background: var(--surface2); padding: 1px 5px; border-radius: 3px; }
  .skill-detail pre { background: var(--surface2); padding: 10px 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; font-size: 0.75rem; }
  .skill-detail pre code { background: none; padding: 0; }
  .skill-detail strong { font-weight: 600; }
  .skill-detail em { font-style: italic; color: var(--text2); }
  .skill-detail hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .skill-detail a { color: var(--accent); }
  .empty-state { text-align: center; padding: 32px; color: var(--text2); font-size: 0.85rem; }
  @media (max-width: 700px) { .skill-row { grid-template-columns: 1fr auto 16px; } .skill-desc { display: none; } }
</style>
</head>
<body>
  <div class="page-header"><h1>Gloss</h1></div>
  <div class="top-nav">
    <a href="/" class="top-nav-tab">Conversations</a>
    <a href="/memory" class="top-nav-tab active">Memory</a>
    <a href="/tools" class="top-nav-tab">Tools</a>
  </div>
  <div class="section-desc">${memories.length} memory files across ${sortedProjects.length} projects. Color indicates type: <span style="color:var(--green)">project</span>, <span style="color:var(--purple)">feedback</span>, <span style="color:var(--blue)">user</span>, <span style="color:var(--yellow)">reference</span>.</div>
  ${memoryHtml}
<script>
var DETAILS = ${JSON.stringify(allDetails).replace(/<\//g, "<\\/")};

function filterRows(input, containerId) {
  var q = input.value.toLowerCase();
  var container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.skill-row').forEach(function(row) {
    var name = (row.getAttribute('data-name') || '').toLowerCase();
    var desc = (row.getAttribute('data-desc') || '').toLowerCase();
    var match = !q || name.includes(q) || desc.includes(q);
    row.style.display = match ? '' : 'none';
    var next = row.nextElementSibling;
    if (next && next.classList.contains('skill-detail')) {
      if (!match) { next.style.display = 'none'; next.classList.remove('open'); }
      else { next.style.removeProperty('display'); }
    }
  });
  container.querySelectorAll('.skill-group').forEach(function(group) {
    var visible = group.querySelectorAll('.skill-row:not([style*="display: none"])').length;
    group.style.display = visible > 0 ? '' : 'none';
  });
}

function toggleDetail(key) {
  var safeId = 'detail-' + key.replace(/[^a-zA-Z0-9]/g, '_');
  var el = document.getElementById(safeId);
  if (!el) return;
  if (el.classList.contains('open')) { el.classList.remove('open'); el.innerHTML = ''; return; }
  document.querySelectorAll('.skill-detail.open').forEach(function(d) { d.classList.remove('open'); d.innerHTML = ''; });
  var content = DETAILS[key];
  if (content) { el.innerHTML = content; el.classList.add('open'); }
}

(function() {
  var saved = localStorage.getItem('convo-viewer-theme');
  if (saved && saved !== 'auto') document.documentElement.setAttribute('data-theme', saved);
})();
</script>
</body>
</html>`;
}

export function buildToolViewerPage(): string {
  const data = scanToolConfig();

  // Deduplicate skills by name
  const seenSkills = new Set<string>();
  const uniqueSkills: SkillInfo[] = [];
  for (const s of data.skills) {
    const key = s.name + "|" + s.scope;
    if (!seenSkills.has(key)) {
      seenSkills.add(key);
      uniqueSkills.push(s);
    }
  }
  data.skills = uniqueSkills;

  // Merge skills + commands into a unified list, deduplicating project items
  // that are identical to a global item with the same name.
  type UnifiedItem = { name: string; description: string; scope: "global" | "project"; project?: string; kind: "skill" | "command" | "agent"; triggers?: string[]; tools?: string; content: string; mcpDeps?: string[] };

  /** Extract unique MCP server names referenced in content via mcp__<server>__<tool> pattern,
   *  plus infer from naming (e.g. squall-unified-review → squall MCP server). */
  function extractMcpDeps(name: string, content: string): string[] {
    const servers = new Set<string>();
    // Explicit references in content
    const matches = content.match(/mcp__([a-zA-Z0-9_-]+)__/g);
    if (matches) {
      for (const m of matches) servers.add(m.replace(/^mcp__/, "").replace(/__$/, ""));
    }
    // Infer from name prefix if there's a matching MCP server
    const mcpNames = new Set(data.mcpServers.map((s) => s.name.toLowerCase()));
    const prefix = name.split("-")[0]?.toLowerCase();
    if (prefix && mcpNames.has(prefix) && prefix !== name.toLowerCase()) {
      servers.add(prefix);
    }
    return [...servers].sort();
  }
  const allItems: UnifiedItem[] = [];
  const seenNames = new Set<string>();

  // Build set of global item names for dedup
  const globalNames = new Set<string>();
  for (const s of data.skills) {
    if (s.scope === "global") globalNames.add(s.name);
  }
  for (const c of data.commands) {
    if (c.scope === "global") globalNames.add(c.name);
  }
  for (const a of data.agents) {
    if (a.scope === "global") globalNames.add(a.name);
  }

  // Skills first (richest metadata)
  for (const s of data.skills) {
    const key = s.name + "|" + s.scope + "|" + (s.project ?? "");
    if (seenNames.has(key)) continue;
    if (s.scope === "project" && globalNames.has(s.name)) continue;
    seenNames.add(key);
    allItems.push({ name: s.name, description: s.oneLiner || s.description, scope: s.scope, project: s.project, kind: "skill", triggers: s.triggers, content: s.content, mcpDeps: extractMcpDeps(s.name, s.content) });
  }
  // Agents
  for (const a of data.agents) {
    const key = a.name + "|" + a.scope + "|" + (a.project ?? "");
    if (seenNames.has(key)) continue;
    if (a.scope === "project" && globalNames.has(a.name)) continue;
    seenNames.add(key);
    allItems.push({ name: a.name, description: a.description, scope: a.scope, project: a.project, kind: "agent", tools: a.tools, content: a.content, mcpDeps: extractMcpDeps(a.name, a.content) });
  }
  // Commands
  for (const c of data.commands) {
    const key = c.name + "|" + c.scope + "|" + (c.project ?? "");
    if (seenNames.has(key)) continue;
    if (c.scope === "project" && globalNames.has(c.name)) continue;
    seenNames.add(key);
    allItems.push({ name: c.name, description: c.description, scope: c.scope, project: c.project, kind: "command", content: c.content, mcpDeps: extractMcpDeps(c.name, c.content) });
  }

  const globalItems = allItems.filter((i) => i.scope === "global");
  const projectItems = allItems.filter((i) => i.scope === "project");

  const projectGroups = new Map<string, UnifiedItem[]>();
  for (const item of projectItems) {
    const proj = item.project ?? "unknown";
    if (!projectGroups.has(proj)) projectGroups.set(proj, []);
    projectGroups.get(proj)!.push(item);
  }

  // Build MCP data
  const mcpPerms = data.permissions.filter((p) => p.startsWith("mcp__"));
  const mcpProjectMap = new Map<string, string[]>();
  for (const [proj, perms] of data.projectMcpPermissions) {
    for (const perm of perms) {
      const name = perm.replace("mcp__", "").replace(/^plugin_\w+_/, "");
      if (!mcpProjectMap.has(name)) mcpProjectMap.set(name, []);
      mcpProjectMap.get(name)!.push(proj);
    }
  }

  // Content for detail view — pre-rendered as HTML
  const allDetails: Record<string, string> = {};
  for (const item of allItems) {
    const raw = item.content.slice(0, 3000);
    allDetails[item.name + "|" + item.scope] = renderMarkdownInline(raw);
  }
  // Plugin details
  for (const p of data.plugins) {
    const lines = [`**${p.name}** from ${p.marketplace}`, ""];
    if (p.description) lines.push(p.description, "");
    lines.push(`- **Version:** ${p.version}`);
    lines.push(`- **Status:** ${p.enabled ? "Enabled" : "Disabled"}`);
    lines.push(`- **Installed:** ${new Date(p.installedAt).toLocaleDateString()}`);
    lines.push(`- **Updated:** ${new Date(p.lastUpdated).toLocaleDateString()}`);
    allDetails["plugin_" + p.name] = renderMarkdownInline(lines.join("\n"));
  }
  // Build reverse map: MCP server → which skills/commands reference it
  const mcpUsedBy = new Map<string, string[]>();
  for (const item of allItems) {
    for (const dep of item.mcpDeps ?? []) {
      if (!mcpUsedBy.has(dep)) mcpUsedBy.set(dep, []);
      mcpUsedBy.get(dep)!.push((item.kind === "command" ? "/" : "") + item.name);
    }
  }

  // MCP server details — merge permission-based and .mcp.json-based project data
  for (const s of data.mcpServers) {
    const permName = `mcp__${s.name}`;
    const isAutoApproved = mcpPerms.includes(permName) || mcpPerms.some((p) => p.replace("mcp__", "").replace(/^plugin_\w+_/, "") === s.name);
    const permProjects = mcpProjectMap.get(s.name) ?? [];
    const usageProjects = data.mcpProjectUsage.get(s.name) ?? [];
    const allProjects = [...new Set([...permProjects, ...usageProjects])].sort();

    const lines: string[] = [];
    lines.push(`**${s.name}**`, "");
    if (s.appSource) lines.push(`- **Scope:** ${s.appSource}`);
    lines.push(`- **Status:** ${s.enabled ? "Connected" : "Needs authentication / offline"}`);
    lines.push(`- **Type:** ${s.type}`);
    if (s.url) lines.push(`- **URL:** \`${s.url}\``);
    if (s.command) lines.push(`- **Command:** \`${[s.command, ...(s.args ?? [])].join(" ")}\``);
    lines.push(`- **Auto-approved:** ${isAutoApproved ? "Yes — Claude uses this without asking" : "No — Claude asks before each use"}`);
    if (s.appSource?.includes("User")) {
      lines.push("", "*Available in all projects*");
      if (allProjects.length > 0) {
        lines.push("", `Also has project-level config in: ${allProjects.join(", ")}`);
      }
    } else if (allProjects.length > 0) {
      lines.push("", `**Installed in:** ${allProjects.join(", ")}`);
    }
    // Reverse links — which skills/commands use this MCP server
    const usedBy = mcpUsedBy.get(s.name) ?? [];
    if (usedBy.length > 0) {
      lines.push("", "**Used by:** " + usedBy.join(", "));
    }
    allDetails["mcp_" + s.name] = renderMarkdownInline(lines.join("\n"));
  }

  // Setting details (for long values)
  for (const [k, v] of Object.entries(data.settings)) {
    const displayValue = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
    if (displayValue.length > 50) {
      allDetails["setting_" + k] = `<pre><code>${esc(displayValue)}</code></pre>`;
    }
  }

  // Group global items by prefix
  const globalGroups = groupByPrefix(globalItems);

  function detailId(key: string): string {
    return "detail-" + key.replace(/[^a-zA-Z0-9]/g, "_");
  }

  function itemRow(item: UnifiedItem): string {
    const key = item.name + "|" + item.scope;
    const triggers = item.triggers ?? [];
    const isCmd = item.kind === "command";
    const isAgent = item.kind === "agent";
    const autoTrigger = item.kind === "skill" && triggers.length > 0;
    const deps = item.mcpDeps ?? [];
    return `
      <div class="skill-row" onclick="toggleDetail('${escJs(key)}')" data-name="${esc(item.name + " " + deps.join(" "))}" data-desc="${esc(item.description)}">
        <span class="skill-name"${isCmd ? ` style="font-family:'SF Mono','Fira Code',monospace"` : ""}>${isCmd ? "/" : ""}${esc(item.name)}</span>
        <span class="skill-desc">${esc(item.description)}</span>
        <span class="skill-badges">
          ${deps.map((d) => `<span class="meta-chip" style="background:var(--accent2);color:var(--accent);cursor:pointer" onclick="event.stopPropagation();navigateTo('mcp','mcp_${escJs(d)}')">${esc(d)}</span>`).join("")}
          ${autoTrigger ? `<span class="meta-chip" style="background:var(--purple-bg);color:var(--purple)">auto</span>` : ""}
          ${isAgent ? `<span class="meta-chip" style="background:var(--cyan-bg);color:var(--cyan)">agent</span>` : ""}
          <span class="card-scope scope-${item.scope}">${item.scope}</span>
        </span>
        <span class="skill-chevron">\u25B6</span>
      </div>
      <div class="skill-detail" id="${detailId(key)}"></div>`;
  }

  function groupHtml(label: string, items: UnifiedItem[]): string {
    return `
    <div class="skill-group">
      <div class="group-label">${esc(label)}<span class="group-count">${items.length}</span></div>
      <div class="skill-list">${items.map(itemRow).join("")}</div>
    </div>`;
  }

  // --- Build unified skills & commands section ---
  let skillsCmdsHtml = `<input class="tab-search" type="text" placeholder="Filter skills and commands..." oninput="filterRows(this, 'sec-skills')">`;
  if (globalItems.length > 0) {
    skillsCmdsHtml += `
    <div class="section-title">Global <span class="badge badge-global">${globalItems.length}</span></div>
    <div class="section-desc">Available in all projects. Skills with <span style="background:var(--purple-bg);color:var(--purple);font-size:0.7rem;padding:1px 6px;border-radius:4px">auto</span> activate when Claude detects matching intent. Click any row to see full prompt.</div>`;
    const sortedGroups = [...globalGroups.entries()].sort((a, b) => {
      if (a[0] === "__standalone__") return 1;
      if (b[0] === "__standalone__") return -1;
      return a[0].localeCompare(b[0]);
    });
    for (const [prefix, items] of sortedGroups) {
      const label = prefix === "__standalone__" ? "Other" : capitalize(prefix);
      skillsCmdsHtml += groupHtml(label, items);
    }
  }
  if (projectItems.length > 0) {
    for (const [proj, items] of projectGroups) {
      skillsCmdsHtml += `<div class="project-divider">${esc(proj)}</div>`;
      const projGrouped = groupByPrefix(items);
      const sortedProjGroups = [...projGrouped.entries()].sort((a, b) => {
        if (a[0] === "__standalone__") return 1;
        if (b[0] === "__standalone__") return -1;
        return a[0].localeCompare(b[0]);
      });
      for (const [prefix, groupItems] of sortedProjGroups) {
        const label = prefix === "__standalone__" ? "Other" : capitalize(prefix);
        skillsCmdsHtml += groupHtml(label, groupItems);
      }
    }
  }
  if (allItems.length === 0) {
    skillsCmdsHtml = '<div class="empty-state">No skills or commands found</div>';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gloss — Tool Viewer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --text: #e6edf3; --text2: #7d8590; --border: #30363d;
    --accent: #da7756; --accent2: #da775620;
    --green: #3fb950; --green-bg: rgba(63, 185, 80, 0.1);
    --blue: #58a6ff; --blue-bg: rgba(88, 166, 255, 0.1);
    --purple: #bc8cff; --purple-bg: rgba(188, 140, 255, 0.1);
    --yellow: #d29922; --yellow-bg: rgba(210, 153, 34, 0.1);
    --cyan: #39d2c0; --cyan-bg: rgba(57, 210, 192, 0.1);
  }
  @media (prefers-color-scheme: light) { :root {
    --bg: #f6f8fa; --surface: #ffffff; --surface2: #f0f2f5;
    --text: #1f2328; --text2: #656d76; --border: #d0d7de;
    --accent: #c2613a; --accent2: #c2613a15;
    --green: #1a7f37; --green-bg: rgba(26, 127, 55, 0.08);
    --blue: #0969da; --blue-bg: rgba(9, 105, 218, 0.08);
    --purple: #8250df; --purple-bg: rgba(130, 80, 223, 0.08);
    --yellow: #9a6700; --yellow-bg: rgba(154, 103, 0, 0.08);
    --cyan: #0d9488; --cyan-bg: rgba(13, 148, 136, 0.08);
  }}
  [data-theme="light"] {
    --bg: #f6f8fa; --surface: #ffffff; --surface2: #f0f2f5;
    --text: #1f2328; --text2: #656d76; --border: #d0d7de;
    --accent: #c2613a; --accent2: #c2613a15;
    --green: #1a7f37; --green-bg: rgba(26, 127, 55, 0.08);
    --blue: #0969da; --blue-bg: rgba(9, 105, 218, 0.08);
    --purple: #8250df; --purple-bg: rgba(130, 80, 223, 0.08);
    --yellow: #9a6700; --yellow-bg: rgba(154, 103, 0, 0.08);
    --cyan: #0d9488; --cyan-bg: rgba(13, 148, 136, 0.08);
  }
  [data-theme="dark"] {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --text: #e6edf3; --text2: #7d8590; --border: #30363d;
    --accent: #da7756; --accent2: #da775620;
    --green: #3fb950; --green-bg: rgba(63, 185, 80, 0.1);
    --blue: #58a6ff; --blue-bg: rgba(88, 166, 255, 0.1);
    --purple: #bc8cff; --purple-bg: rgba(188, 140, 255, 0.1);
    --yellow: #d29922; --yellow-bg: rgba(210, 153, 34, 0.1);
    --cyan: #39d2c0; --cyan-bg: rgba(57, 210, 192, 0.1);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 32px 24px; max-width: 1100px; margin: 0 auto;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .page-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .page-header h1 { font-size: 1.4rem; font-weight: 600; }
  .top-nav {
    display: flex; gap: 0; margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .top-nav-tab {
    padding: 8px 16px 8px 0; margin-right: 8px;
    font-size: 0.85rem; font-weight: 500;
    color: var(--text2); text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .top-nav-tab:hover { color: var(--text); text-decoration: none; }
  .top-nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .nav-tabs {
    display: flex; gap: 2px; margin-bottom: 24px;
    border-bottom: 1px solid var(--border); overflow-x: auto;
  }
  .nav-tab {
    padding: 8px 16px; font-size: 0.82rem; font-weight: 500;
    color: var(--text2); cursor: pointer; border: none; background: none;
    border-bottom: 2px solid transparent; transition: all 0.15s;
    white-space: nowrap; font-family: inherit;
  }
  .nav-tab:hover { color: var(--text); }
  .nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .nav-tab .tab-count {
    display: inline-block; background: var(--surface2); color: var(--text2);
    font-size: 0.7rem; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
  }
  .nav-tab.active .tab-count { background: var(--accent2); color: var(--accent); }

  .section { display: none; }
  .section.active { display: block; }
  .section-title {
    font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text2); margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .section-desc { font-size: 0.8rem; color: var(--text2); margin: -8px 0 16px; line-height: 1.4; }
  .section-title .badge {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 10px;
    font-weight: 500; text-transform: none; letter-spacing: 0;
  }
  .badge-global { background: var(--blue-bg); color: var(--blue); }
  .badge-project { background: var(--green-bg); color: var(--green); }

  .card-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 8px; margin-bottom: 16px;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 16px; transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--text2); }
  .card.clickable { cursor: pointer; }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .card-icon {
    width: 28px; height: 28px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; flex-shrink: 0;
  }
  .card-name { font-size: 0.88rem; font-weight: 600; }
  .card-scope {
    font-size: 0.68rem; padding: 1px 6px; border-radius: 4px;
    font-weight: 500; margin-left: auto; flex-shrink: 0;
  }
  .scope-global { background: var(--blue-bg); color: var(--blue); }
  .scope-project { background: var(--green-bg); color: var(--green); }
  .scope-plugin { background: var(--purple-bg); color: var(--purple); }
  .scope-desktop { background: var(--yellow-bg); color: var(--yellow); }
  .card-desc { font-size: 0.8rem; color: var(--text2); line-height: 1.4; margin-bottom: 2px; }
  .card-projects { font-size: 0.72rem; color: var(--green); margin-top: 4px; }
  .card-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .meta-chip {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 4px;
    background: var(--surface2); color: var(--text2);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .meta-chip.trigger { background: var(--cyan-bg); color: var(--cyan); }

  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; flex-shrink: 0; }
  .status-enabled { background: var(--green); }
  .status-auth { background: var(--yellow); }
  .status-disabled { background: var(--text2); opacity: 0.4; }

  /* Skill/command rows */
  .skill-group { margin-bottom: 20px; }
  .group-label {
    font-size: 0.82rem; font-weight: 600; color: var(--text);
    margin-bottom: 4px; padding: 4px 0; display: flex; align-items: center; gap: 8px;
  }
  .group-count {
    font-size: 0.68rem; background: var(--surface2); color: var(--text2);
    padding: 1px 6px; border-radius: 10px; font-weight: 500;
  }
  .skill-list {
    background: var(--border); border-radius: 8px; overflow: hidden;
    display: flex; flex-direction: column; gap: 1px;
  }
  .skill-row {
    display: grid; grid-template-columns: 200px 1fr auto 16px;
    gap: 12px; align-items: center; padding: 10px 14px;
    background: var(--surface); cursor: pointer; transition: background 0.1s;
  }
  .skill-row:hover { background: var(--surface2); }
  .skill-name { font-size: 0.85rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; }
  .skill-desc { font-size: 0.8rem; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .skill-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
  .skill-chevron { color: var(--text2); font-size: 0.6rem; transition: transform 0.15s; flex-shrink: 0; }

  /* Search */
  .tab-search {
    width: 100%; padding: 8px 12px; margin-bottom: 16px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); font-size: 0.85rem; outline: none; font-family: inherit;
  }
  .tab-search:focus { border-color: var(--accent); }
  .tab-search::placeholder { color: var(--text2); }
  .skill-detail {
    display: none; padding: 16px 20px; background: var(--surface);
    border-top: 1px dashed var(--border);
    font-size: 0.82rem; line-height: 1.6; color: var(--text);
    max-height: 400px; overflow-y: auto;
  }
  .skill-detail.open { display: block; }
  .skill-detail h1, .skill-detail h2, .skill-detail h3, .skill-detail h4 {
    font-weight: 600; margin: 12px 0 6px; color: var(--text);
  }
  .skill-detail h1 { font-size: 1.1rem; }
  .skill-detail h2 { font-size: 0.95rem; }
  .skill-detail h3 { font-size: 0.88rem; }
  .skill-detail p { margin: 6px 0; }
  .skill-detail ul, .skill-detail ol { margin: 6px 0; padding-left: 20px; }
  .skill-detail li { margin: 2px 0; }
  .skill-detail code {
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.78rem;
    background: var(--surface2); padding: 1px 5px; border-radius: 3px;
  }
  .skill-detail pre {
    background: var(--surface2); padding: 10px 12px; border-radius: 6px;
    overflow-x: auto; margin: 8px 0; font-size: 0.75rem; line-height: 1.5;
  }
  .skill-detail pre code { background: none; padding: 0; }
  .skill-detail table { border-collapse: collapse; margin: 8px 0; font-size: 0.78rem; }
  .skill-detail th, .skill-detail td {
    border: 1px solid var(--border); padding: 4px 10px; text-align: left;
  }
  .skill-detail th { background: var(--surface2); font-weight: 600; }
  .skill-detail strong { font-weight: 600; }
  .skill-detail em { font-style: italic; color: var(--text2); }
  .skill-detail hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .skill-detail a { color: var(--accent); }

  /* Detail panels (for non-skill cards) */
  .detail-panel {
    display: none; margin-top: 10px; padding: 12px 14px;
    background: var(--surface2); border-radius: 6px;
    font-size: 0.78rem; line-height: 1.6; color: var(--text);
    white-space: pre-wrap; word-break: break-word;
    max-height: 300px; overflow-y: auto;
  }
  .detail-panel.open { display: block; }

  .project-divider {
    font-size: 0.82rem; font-weight: 600; color: var(--green);
    padding: 12px 0 4px; margin-top: 8px;
    display: flex; align-items: center; gap: 8px;
  }
  .project-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }

  .empty-state { text-align: center; padding: 32px; color: var(--text2); font-size: 0.85rem; }

  @media (max-width: 700px) {
    .card-grid { grid-template-columns: 1fr; }
    .skill-row { grid-template-columns: 1fr auto 16px; gap: 4px; }
    .skill-desc { display: none; }
    .skill-name { min-width: 0; }
  }
</style>
</head>
<body>
  <div class="page-header"><h1>Gloss</h1></div>
  <div class="top-nav">
    <a href="/" class="top-nav-tab">Conversations</a>
    <a href="/memory" class="top-nav-tab">Memory</a>
    <a href="/tools" class="top-nav-tab active">Tools</a>
  </div>

  <div class="nav-tabs">
    <button class="nav-tab active" onclick="showTab('mcp')">MCP Servers<span class="tab-count">${data.mcpServers.length}</span></button>
    <button class="nav-tab" onclick="showTab('skills')">Skills & Commands<span class="tab-count">${allItems.length}</span></button>
    <button class="nav-tab" onclick="showTab('plugins')">Plugins<span class="tab-count">${data.plugins.length}</span></button>
    <button class="nav-tab" onclick="showTab('hooks')">Hooks<span class="tab-count">${data.hooks.length}</span></button>
    <button class="nav-tab" onclick="showTab('env')">Env & Settings</button>
    <button class="nav-tab" onclick="showTab('backup')">Backup</button>
  </div>

  <!-- MCP Servers -->
  <div class="section active" id="sec-mcp">
    <input class="tab-search" type="text" placeholder="Filter servers..." oninput="filterRows(this, 'sec-mcp')">
    ${(() => {
      if (data.mcpServers.length === 0) return '<div class="empty-state">No MCP servers found. Is the <code>claude</code> CLI installed?</div>';

      // Group MCP servers by scope
      const cloudServers = data.mcpServers.filter((s) => s.appSource?.includes("Claude.ai"));
      const userServers = data.mcpServers.filter((s) => s.appSource?.includes("User") || s.appSource?.includes("all projects"));
      const perProjectServers = data.mcpServers.filter((s) => !cloudServers.includes(s) && !userServers.includes(s));

      function mcpRow(s: McpServerInfo): string {
        const permName = "mcp__" + s.name;
        const isAutoApproved = mcpPerms.includes(permName) || mcpPerms.some((p) => p.replace("mcp__", "").replace(/^plugin_\w+_/, "") === s.name);
        const desc = s.type === "http" ? (s.url ?? "") : [s.command, ...(s.args ?? [])].join(" ");
        const detKey = "mcp_" + s.name;
        const statusClass = s.enabled ? "status-enabled" : (s.appSource?.includes("Claude.ai") ? "status-auth" : "status-auth");
        const statusLabel = s.enabled ? "" : "needs auth";
        return `
      <div class="skill-row" onclick="toggleDetail('${escJs(detKey)}')" data-name="${esc(s.name)}" data-desc="${esc(desc)}">
        <span class="skill-name"><span class="status-dot ${statusClass}"></span>${esc(s.name)}</span>
        <span class="skill-desc">${esc(desc)}</span>
        <span class="skill-badges">
          ${!s.enabled ? `<span class="meta-chip" style="background:var(--yellow-bg);color:var(--yellow)">${statusLabel}</span>` : ""}
          ${isAutoApproved ? `<span class="meta-chip" style="background:var(--green-bg);color:var(--green)">approved</span>` : ""}
        </span>
        <span class="skill-chevron">\u25B6</span>
      </div>
      <div class="skill-detail" id="${detailId(detKey)}"></div>`;
      }

      let html = "";
      if (userServers.length > 0) {
        html += `<div class="skill-group"><div class="group-label">All projects<span class="group-count">${userServers.length}</span></div>
        <div class="section-desc" style="margin-top:-4px">Available everywhere you use Claude Code</div>
        <div class="skill-list">${userServers.map(mcpRow).join("")}</div></div>`;
      }
      if (perProjectServers.length > 0) {
        html += `<div class="skill-group"><div class="group-label">Per-project<span class="group-count">${perProjectServers.length}</span></div>
        <div class="section-desc" style="margin-top:-4px">Only available in specific projects — expand to see which</div>
        <div class="skill-list">${perProjectServers.map(mcpRow).join("")}</div></div>`;
      }
      if (cloudServers.length > 0) {
        html += `<div class="skill-group"><div class="group-label">Claude.ai integrations<span class="group-count">${cloudServers.length}</span></div>
        <div class="section-desc" style="margin-top:-4px">Cloud-hosted, managed by Anthropic</div>
        <div class="skill-list">${cloudServers.map(mcpRow).join("")}</div></div>`;
      }
      return html;
    })()}
  </div>

  <!-- Skills & Commands -->
  <div class="section" id="sec-skills">${skillsCmdsHtml}</div>

  <!-- Plugins -->
  <div class="section" id="sec-plugins">
    <div class="section-desc">Installed from the Claude marketplace. Provide MCP servers, LSP, and other integrations.</div>
    ${data.plugins.length > 0 ? `
    <div class="skill-list">
      ${data.plugins.map((p) => `
      <div class="skill-row" onclick="toggleDetail('plugin_${escJs(p.name)}')" data-name="${esc(p.name)}" data-desc="${esc(p.description)}">
        <span class="skill-name"><span class="status-dot ${p.enabled ? "status-enabled" : "status-disabled"}"></span>${esc(p.name)}</span>
        <span class="skill-desc">${esc(p.description)}</span>
        <span class="skill-badges">
          <span class="meta-chip">v${esc(p.version)}</span>
          <span class="card-scope scope-plugin">${esc(p.marketplace)}</span>
        </span>
        <span class="skill-chevron">\u25B6</span>
      </div>
      <div class="skill-detail" id="detail-plugin_${esc(p.name.replace(/[^a-zA-Z0-9]/g, "_"))}"></div>`).join("")}
    </div>` : '<div class="empty-state">No plugins installed</div>'}
  </div>

  <!-- Hooks -->
  <div class="section" id="sec-hooks">
    <div class="section-desc">Shell commands that run automatically in response to Claude Code events.</div>
    ${data.hooks.length > 0 ? `
    <div class="skill-list">
      ${data.hooks.map((h) => `
      <div class="skill-row" onclick="toggleDetail('hook_${escJs(h.event + h.command.slice(0, 20))}')">
        <span class="skill-name">${esc(h.event)}</span>
        <span class="skill-desc" style="font-family:'SF Mono','Fira Code',monospace;font-size:0.78rem">${esc(h.command)}</span>
        <span class="skill-badges"><span class="card-scope scope-${h.scope}">${h.scope}${h.project ? ` \u00b7 ${esc(h.project)}` : ""}</span></span>
      </div>
      <div class="skill-detail" id="detail-hook_${esc((h.event + h.command.slice(0, 20)).replace(/[^a-zA-Z0-9]/g, "_"))}"></div>`).join("")}
    </div>` : '<div class="empty-state">No hooks configured</div>'}
  </div>

  <!-- Env & Settings -->
  <div class="section" id="sec-env">
    ${Object.keys(data.envVars).length > 0 ? `
    <div class="section-title">Environment Variables</div>
    <div class="section-desc">Injected into Claude Code's environment at startup via settings.json.</div>
    <div class="skill-list">
      ${Object.entries(data.envVars).map(([k, v]) => `
      <div class="skill-row" style="cursor:default">
        <span class="skill-name" style="font-size:0.78rem;min-width:0">${esc(k)}</span>
        <span class="skill-desc">${ENV_DESCRIPTIONS[k] ? esc(ENV_DESCRIPTIONS[k]) : ""}</span>
        <span class="skill-badges"><span class="meta-chip">${esc(v)}</span></span>
        <span></span>
      </div>`).join("")}
    </div>` : ""}

    ${Object.keys(data.settings).length > 0 ? `
    <div class="section-title" style="margin-top:20px">General Settings</div>
    <div class="section-desc">From ~/.claude/settings.json &mdash; controls Claude Code behavior globally.</div>
    <div class="skill-list">
      ${Object.entries(data.settings).map(([k, v]) => {
        const displayValue = typeof v === "object" ? JSON.stringify(v) : String(v);
        const isLong = displayValue.length > 50;
        return `
      <div class="skill-row"${isLong ? ` onclick="toggleDetail('setting_${escJs(k)}')"` : ` style="cursor:default"`}>
        <span class="skill-name" style="font-size:0.78rem;min-width:0">${esc(k)}</span>
        <span class="skill-desc">${SETTING_DESCRIPTIONS[k] ? esc(SETTING_DESCRIPTIONS[k]) : ""}</span>
        <span class="skill-badges">${!isLong ? `<span class="meta-chip">${esc(displayValue)}</span>` : `<span class="meta-chip">click to view</span>`}</span>
        ${isLong ? `<span class="skill-chevron">\u25B6</span>` : `<span></span>`}
      </div>
      ${isLong ? `<div class="skill-detail" id="detail-setting_${esc(k.replace(/[^a-zA-Z0-9]/g, "_"))}"></div>` : ""}`;
      }).join("")}
    </div>` : ""}

    ${Object.keys(data.envVars).length === 0 && Object.keys(data.settings).length === 0 ? '<div class="empty-state">No environment variables or settings</div>' : ""}
  </div>

  <!-- Backup -->
  <div class="section" id="sec-backup">
    <div class="section-title">Backup Claude Code</div>
    <div class="section-desc">Export all config, MCP servers, skills, commands, agents, memory, and conversations to a directory.</div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:500px">
      <div style="margin-bottom:12px">
        <label style="font-size:0.82rem;font-weight:500;display:block;margin-bottom:4px">Destination path</label>
        <div style="display:flex;gap:8px">
          <input id="backupDest" type="text" class="tab-search" style="margin-bottom:0;flex:1" placeholder="/Volumes/External/claude-backup">
          <button onclick="pickFolder()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:6px;font-size:0.82rem;cursor:pointer;white-space:nowrap;font-family:inherit">Browse&hellip;</button>
        </div>
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:0.82rem;display:flex;align-items:center;gap:8px;cursor:pointer">
          <input id="backupFull" type="checkbox"> Include conversations (~15GB) and Gloss DB
        </label>
        <div style="font-size:0.72rem;color:var(--text2);margin-top:4px;margin-left:24px">Without this, only config is backed up (~9MB)</div>
      </div>
      <button onclick="runBackup()" style="background:var(--accent);color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:0.85rem;font-weight:500;cursor:pointer;font-family:inherit">Run Backup</button>
      <div id="backupStatus" style="margin-top:12px;font-size:0.82rem;color:var(--text2);white-space:pre-wrap"></div>
    </div>
  </div>

<script>
var DETAILS = ${JSON.stringify(allDetails).replace(/<\//g, "<\\/")};

function showTab(id) {
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('sec-' + id).classList.add('active');
  event.currentTarget.classList.add('active');
}

function navigateTo(tabId, detailKey) {
  // Switch to the target tab
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  var section = document.getElementById('sec-' + tabId);
  if (!section) return;
  section.classList.add('active');
  // Highlight the matching tab button
  document.querySelectorAll('.nav-tab').forEach(function(t) {
    if (t.textContent.toLowerCase().includes(tabId === 'skills' ? 'skills' : tabId)) t.classList.add('active');
  });
  // Clear any search filter
  var search = section.querySelector('.tab-search');
  if (search) { search.value = ''; filterRows(search, 'sec-' + tabId); }
  // Close any open details first
  document.querySelectorAll('.skill-detail.open').forEach(function(d) { d.classList.remove('open'); d.innerHTML = ''; });
  // Open the target detail
  setTimeout(function() {
    toggleDetail(detailKey);
    // Scroll to it
    var safeId = 'detail-' + detailKey.replace(/[^a-zA-Z0-9]/g, '_');
    var el = document.getElementById(safeId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

function filterRows(input, sectionId) {
  var q = input.value.toLowerCase();
  var section = document.getElementById(sectionId);
  if (!section) return;
  section.querySelectorAll('.skill-row').forEach(function(row) {
    var name = (row.getAttribute('data-name') || row.textContent || '').toLowerCase();
    var desc = (row.getAttribute('data-desc') || '').toLowerCase();
    var match = !q || name.includes(q) || desc.includes(q);
    row.style.display = match ? '' : 'none';
    // Also hide the detail panel below it
    var next = row.nextElementSibling;
    if (next && next.classList.contains('skill-detail')) {
      if (!match) { next.style.display = 'none'; next.classList.remove('open'); }
      else { next.style.removeProperty('display'); }
    }
  });
  // Hide group labels with no visible children
  section.querySelectorAll('.skill-group').forEach(function(group) {
    var visible = group.querySelectorAll('.skill-row:not([style*="display: none"])').length;
    group.style.display = visible > 0 ? '' : 'none';
  });
}

function toggleDetail(key) {
  var safeId = 'detail-' + key.replace(/[^a-zA-Z0-9]/g, '_');
  var el = document.getElementById(safeId);
  if (!el) return;
  if (el.classList.contains('open')) {
    el.classList.remove('open'); el.innerHTML = ''; return;
  }
  document.querySelectorAll('.detail-panel.open, .skill-detail.open').forEach(function(d) {
    d.classList.remove('open'); d.innerHTML = '';
  });
  var content = DETAILS[key];
  if (content) {
    el.innerHTML = content;
    // Make "Used by" items clickable — link to skills tab
    el.querySelectorAll('strong').forEach(function(b) {
      if (b.textContent !== 'Used by:') return;
      var parent = b.parentElement;
      if (!parent) return;
      var afterStrong = parent.textContent.replace('Used by:', '').trim();
      var items = afterStrong.split(', ').filter(function(n) { return n.trim(); });
      var html = '<strong>Used by:<' + '/strong> ';
      html += items.map(function(n) {
        var clean = n.trim();
        var dk = (clean.charAt(0) === '/' ? clean.slice(1) : clean) + '|global';
        return '<a href="#" onclick="event.preventDefault();navigateTo(' + "'" + 'skills' + "'" + ',' + "'" + dk + "'" + ')" style="color:var(--accent)">' + clean + '<' + '/a>';
      }).join(', ');
      parent.innerHTML = html;
    });
    el.classList.add('open');
  }
}

function pickFolder() {
  var status = document.getElementById('backupStatus');
  status.textContent = 'Opening folder picker...';
  status.style.color = 'var(--text2)';
  fetch('/api/pick-folder', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.path) {
        document.getElementById('backupDest').value = data.path + 'claude-backup';
        status.textContent = '';
      } else if (data.cancelled) {
        status.textContent = '';
      } else {
        status.textContent = 'Could not open folder picker.';
      }
    })
    .catch(function() { status.textContent = ''; });
}

function runBackup() {
  var dest = document.getElementById('backupDest').value.trim();
  var full = document.getElementById('backupFull').checked;
  var status = document.getElementById('backupStatus');
  if (!dest) { status.textContent = 'Please enter a destination path.'; return; }
  status.textContent = full ? 'Running full backup (this may take a few minutes)...' : 'Running config backup...';
  fetch('/api/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: dest, full: full })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.ok) {
      status.textContent = data.output || 'Backup complete!';
      status.style.color = 'var(--green)';
    } else {
      status.textContent = 'Error: ' + (data.error || data.output || 'Unknown error');
      status.style.color = 'var(--red)';
    }
  })
  .catch(function(e) {
    status.textContent = 'Error: ' + e.message;
    status.style.color = 'var(--red)';
  });
}

(function() {
  var saved = localStorage.getItem('convo-viewer-theme');
  if (saved && saved !== 'auto') document.documentElement.setAttribute('data-theme', saved);
})();
</script>
</body>
</html>`;
}
