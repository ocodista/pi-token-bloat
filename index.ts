import { DefaultPackageManager, SettingsManager, formatSkillsForPrompt, getAgentDir, type ExtensionAPI, type Skill, type Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

type BloatSectionName = "Context files" | "Skills" | "Prompts" | "Extensions";
type BloatChartName = "All" | BloatSectionName;

type BloatItem = {
	section: BloatSectionName;
	label: string;
	path: string;
	tokens: number;
	note: string;
	sourceTokens?: number;
};

type BloatSection = {
	name: BloatSectionName;
	tokens: number;
	items: BloatItem[];
	note: string;
};

type BloatChart = {
	name: BloatChartName;
	tokens: number;
	items: BloatItem[];
};

type TokenBloatReport = {
	sections: BloatSection[];
	totalFiles: number;
	totalTokens: number;
	systemPromptTokens?: number;
	providerPayloadTokens?: number;
};

type TokenBloatConfig = {
	showSummaryOnOnboarding: boolean;
};

type CustomUiContext = {
	ui: {
		custom: <T>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component, options?: unknown) => Promise<T>;
	};
};

type Frontmatter = Record<string, string | boolean>;

const TOKEN_DIVISOR = 4;
const SUMMARY_WIDGET_KEY = "token-bloat-summary";
const SUMMARY_VISIBLE_MS = 10_000;
const CONFIG_FILE_NAME = "token-bloat.json";
const DEFAULT_CONFIG: TokenBloatConfig = { showSummaryOnOnboarding: true };
const BAR_MAX_WIDTH = 14;
const TOKEN_WIDTH = 10;
const MAX_VISIBLE_ITEMS = 12;
const ON_DEMAND_NOTE = "not startup context; sent to the model when invoked";

function tokenCount(text: string): number {
	return text.length / TOKEN_DIVISOR;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
}

function readText(filePath: string): string | undefined {
	try {
		return existsSync(filePath) && statSync(filePath).isFile() ? readFileSync(filePath, "utf-8") : undefined;
	} catch {
		return undefined;
	}
}

function readTokenCount(filePath: string): number {
	return tokenCount(readText(filePath) ?? "");
}

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

function isConfigRecord(value: unknown): value is { showSummaryOnOnboarding?: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTokenBloatConfig(): TokenBloatConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf-8"));
		if (!isConfigRecord(parsed)) return DEFAULT_CONFIG;
		return {
			showSummaryOnOnboarding: typeof parsed.showSummaryOnOnboarding === "boolean" ? parsed.showSummaryOnOnboarding : DEFAULT_CONFIG.showSummaryOnOnboarding,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

function writeTokenBloatConfig(config: TokenBloatConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function expandResource(sectionName: BloatSectionName, resourcePath: string): string[] {
	try {
		if (!statSync(resourcePath).isDirectory()) return [resourcePath];
		if (sectionName === "Skills") {
			const skillPath = join(resourcePath, "SKILL.md");
			return existsSync(skillPath) ? [skillPath] : [];
		}
		if (sectionName === "Prompts") return readdirSync(resourcePath).filter((entry) => entry.endsWith(".md")).map((entry) => join(resourcePath, entry));
		const indexPath = ["index.ts", "index.js"].map((entry) => join(resourcePath, entry)).find(existsSync);
		return indexPath ? [indexPath] : [];
	} catch {
		return [resourcePath];
	}
}

function labelForPath(sectionName: BloatSectionName, filePath: string): string {
	const fileName = basename(filePath);
	if (sectionName === "Context files") return basename(filePath);
	if (sectionName === "Skills") return fileName === "SKILL.md" ? basename(dirname(filePath)) : basename(filePath, extname(filePath));
	if (sectionName === "Prompts") return `/${basename(filePath, extname(filePath))}`;
	return fileName === "index.ts" || fileName === "index.js" ? basename(dirname(filePath)) : basename(filePath, extname(filePath));
}

function sumTokens(items: BloatItem[]): number {
	return items.reduce((sum, item) => sum + item.tokens, 0);
}

function parseFrontmatter(text: string): Frontmatter {
	const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return {};
	const result: Frontmatter = {};
	for (const line of match[1]!.split("\n")) {
		const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!entry) continue;
		const key = entry[1]!;
		const raw = entry[2]!.trim().replace(/^['"]|['"]$/g, "");
		result[key] = raw === "true" ? true : raw === "false" ? false : raw;
	}
	return result;
}

function readSkill(filePath: string): Skill | undefined {
	const text = readText(filePath);
	if (!text) return undefined;
	const frontmatter = parseFrontmatter(text);
	if (typeof frontmatter.description !== "string") return undefined;
	const name = typeof frontmatter.name === "string" ? frontmatter.name : labelForPath("Skills", filePath);
	return {
		name,
		description: frontmatter.description,
		filePath,
		baseDir: dirname(filePath),
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		sourceInfo: { path: filePath, source: "token-bloat", scope: "temporary", origin: "top-level" },
	};
}

function buildContextFileSection(contextFiles: Array<{ path: string; content: string }>): BloatSection {
	const items = contextFiles
		.map((file) => ({
			section: "Context files" as const,
			label: labelForPath("Context files", file.path),
			path: file.path,
			tokens: tokenCount(file.content),
			note: "loaded directly into the system prompt",
		}))
		.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
	return { name: "Context files", tokens: sumTokens(items), items, note: "AGENTS.md/CLAUDE.md and other context files loaded into the system prompt." };
}

function buildSkillSection(paths: string[]): BloatSection {
	const skills = Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b)).map(readSkill).filter((skill): skill is Skill => Boolean(skill));
	const items = skills
		.map((skill) => {
			const promptText = skill.disableModelInvocation ? "" : formatSkillsForPrompt([skill]);
			return {
				section: "Skills" as const,
				label: skill.name,
				path: skill.filePath,
				tokens: tokenCount(promptText),
				sourceTokens: readTokenCount(skill.filePath),
				note: skill.disableModelInvocation ? "hidden from automatic model invocation" : "only name + description are in startup context; full SKILL.md loads on demand",
			};
		})
		.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
	return {
		name: "Skills",
		tokens: tokenCount(formatSkillsForPrompt(skills)),
		items,
		note: "Counts the skill catalog inserted in the system prompt, not full skill files.",
	};
}

function buildPromptSection(paths: string[]): BloatSection {
	const items = Array.from(new Set(paths))
		.sort((a, b) => a.localeCompare(b))
		.map((path) => ({
			section: "Prompts" as const,
			label: labelForPath("Prompts", path),
			path,
			tokens: readTokenCount(path),
			note: ON_DEMAND_NOTE,
		}))
		.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
	return { name: "Prompts", tokens: sumTokens(items), items, note: "Prompt templates are counted by full template size, but only enter model context when invoked." };
}

function toolContextTokens(tool: ReturnType<ExtensionAPI["getAllTools"]>[number]): number {
	return tokenCount(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function isExtensionTool(tool: ReturnType<ExtensionAPI["getAllTools"]>[number]): boolean {
	return tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk";
}

function buildExtensionSection(paths: string[], pi: ExtensionAPI): BloatSection {
	const activeTools = new Set(pi.getActiveTools());
	const tools = pi.getAllTools().filter((tool) => activeTools.has(tool.name) && isExtensionTool(tool));
	const toolsByPath = new Map<string, typeof tools>();
	for (const tool of tools) {
		const key = tool.sourceInfo.path;
		toolsByPath.set(key, [...(toolsByPath.get(key) ?? []), tool]);
	}
	const allPaths = Array.from(new Set([...paths, ...tools.map((tool) => tool.sourceInfo.path)])).sort((a, b) => a.localeCompare(b));
	const items = allPaths
		.map((path) => {
			const pathTools = toolsByPath.get(path) ?? [];
			const toolNames = pathTools.map((tool) => tool.name).join(", ");
			return {
				section: "Extensions" as const,
				label: labelForPath("Extensions", path),
				path,
				tokens: pathTools.reduce((sum, tool) => sum + toolContextTokens(tool), 0),
				sourceTokens: readTokenCount(path),
				note: pathTools.length ? `active tool schema/description counted: ${toolNames}; implementation, commands, and UI are not sent` : "implementation, commands, and UI are not sent to the model",
			};
		})
		.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
	return { name: "Extensions", tokens: sumTokens(items), items, note: "Counts only active extension tool metadata. Extension source code is not model context." };
}

async function collectTokenBloat(cwd: string, pi: ExtensionAPI, systemPrompt?: string, contextFiles: Array<{ path: string; content: string }> = []): Promise<TokenBloatReport> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const paths = await packageManager.resolve();
	const enabled = (resources: { enabled: boolean; path: string }[]): string[] => resources.filter((resource) => resource.enabled).map((resource) => resource.path);
	const sections = [
		buildContextFileSection(contextFiles),
		buildSkillSection(enabled(paths.skills).flatMap((path) => expandResource("Skills", path))),
		buildPromptSection(enabled(paths.prompts).flatMap((path) => expandResource("Prompts", path))),
		buildExtensionSection(enabled(paths.extensions).flatMap((path) => expandResource("Extensions", path)), pi),
	];
	const totalFiles = sections.reduce((sum, section) => sum + section.items.length, 0);
	return {
		sections,
		totalFiles,
		totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
		systemPromptTokens: systemPrompt === undefined ? undefined : tokenCount(systemPrompt),
	};
}

function renderTokenBloat(report: TokenBloatReport, theme: Theme): string[] {
	const muted = (text: string) => theme.fg("dim", text);
	const system = report.systemPromptTokens === undefined ? [] : [muted(`  System prompt ${formatNumber(report.systemPromptTokens)} tokens`)];
	const payload = report.providerPayloadTokens === undefined ? [] : [muted(`  Last provider payload ${formatNumber(report.providerPayloadTokens)} tokens`)];
	return [
		theme.fg("mdHeading", "[TokenBloat]"),
		...system,
		...payload,
		...report.sections.map((section) => `  ${theme.fg("accent", section.name)} ${muted(`${formatNumber(section.items.length)} resources, ${formatNumber(section.tokens)} tokens`)}`),
		muted(`  Attributed total ${formatNumber(report.totalFiles)} resources, ${formatNumber(report.totalTokens)} tokens`),
	];
}

function buildCharts(sections: BloatSection[]): BloatChart[] {
	const allItems = sections.flatMap((section) => section.items).sort((a, b) => b.tokens - a.tokens || a.section.localeCompare(b.section) || a.label.localeCompare(b.label));
	return [{ name: "All", tokens: sumTokens(allItems), items: allItems }, ...sections];
}

function chartItemLabel(chart: BloatChart, item: BloatItem): string {
	return chart.name === "All" ? `${item.section} · ${item.label}` : item.label;
}

class TokenBloatModal implements Component {
	private readonly charts: BloatChart[];
	private selectedChartIndex = 0;
	private selectedItemIndex = 0;

	constructor(
		private readonly tui: TUI,
		private readonly report: TokenBloatReport,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {
		this.charts = buildCharts(report.sections);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
			this.done();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) this.selectChart(this.selectedChartIndex + 1);
		else if (matchesKey(data, "left")) this.selectChart(this.selectedChartIndex + this.charts.length - 1);
		else if (/^[1-9]$/.test(data) && Number(data) <= this.charts.length) this.selectChart(Number(data) - 1);
		else if (matchesKey(data, "up") || data === "k") this.selectItem(-1);
		else if (matchesKey(data, "down") || data === "j") this.selectItem(1);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const chart = this.currentChart();
		const innerWidth = Math.max(1, width - 4);
		return frame(
			[
				`${this.theme.fg("accent", this.theme.bold("TokenBloat"))} ${this.theme.fg("dim", "LLM context footprint")}`,
				this.renderTotals(),
				this.renderTabs(),
				this.renderChartMeta(chart),
				`${this.theme.fg("muted", "Tokens".padStart(TOKEN_WIDTH))}  ${this.theme.fg("muted", "─".repeat(BAR_MAX_WIDTH))}  ${this.theme.fg("muted", "Resource")}`,
				...this.renderItems(chart, innerWidth),
				this.renderSelectionDetail(chart),
				this.theme.fg("dim", `↑↓ navigate · ←/→ or Tab switch chart · 1-${this.charts.length} jump · Enter/Esc close`),
			],
			innerWidth,
			this.theme,
		);
	}

	invalidate(): void {}

	private currentChart(): BloatChart {
		return this.charts[this.selectedChartIndex] ?? this.charts[0]!;
	}

	private renderTotals(): string {
		const system = this.report.systemPromptTokens === undefined ? "system prompt not measured yet" : `system prompt ~${formatNumber(this.report.systemPromptTokens)} tokens`;
		const payload = this.report.providerPayloadTokens === undefined ? "" : `; last provider payload ~${formatNumber(this.report.providerPayloadTokens)} tokens`;
		return this.theme.fg("dim", `${system}${payload}; attributed resources/on-demand prompts ~${formatNumber(this.report.totalTokens)} tokens across ${formatNumber(this.report.totalFiles)} resources`);
	}

	private selectChart(index: number): void {
		this.selectedChartIndex = ((index % this.charts.length) + this.charts.length) % this.charts.length;
		this.selectedItemIndex = 0;
	}

	private selectItem(direction: -1 | 1): void {
		const { items } = this.currentChart();
		if (items.length === 0) return;
		this.selectedItemIndex = (this.selectedItemIndex + direction + items.length) % items.length;
	}

	private renderTabs(): string {
		return this.charts
			.map((chart, index) => {
				const tab = `${index + 1}. ${chart.name} (${formatNumber(chart.items.length)}) ${formatNumber(chart.tokens)}`;
				return index === this.selectedChartIndex ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${this.theme.bold(tab)} `)) : this.theme.fg("dim", ` ${tab} `);
			})
			.join(" ");
	}

	private renderChartMeta(chart: BloatChart): string {
		const percent = this.report.totalTokens > 0 ? (chart.tokens / this.report.totalTokens) * 100 : 0;
		const section = this.report.sections.find((item) => item.name === chart.name);
		const note = section?.note ?? "All attributed resource entries, sorted by model-facing or on-demand size.";
		return `${this.theme.fg("accent", chart.name)} ${this.theme.fg("dim", `${formatNumber(chart.items.length)} resources · ${formatNumber(chart.tokens)} tokens · ${formatNumber(percent)}% of attributed total · ${note}`)}`;
	}

	private renderItems(chart: BloatChart, width: number): string[] {
		if (chart.items.length === 0) return [this.theme.fg("dim", "  No items")];
		const maxVisible = Math.min(Math.max(chart.items.length, 1), MAX_VISIBLE_ITEMS);
		const start = Math.max(0, Math.min(this.selectedItemIndex - Math.floor(maxVisible / 2), chart.items.length - maxVisible));
		const maxTokens = Math.max(...chart.items.map((item) => item.tokens), 1);
		const lines = chart.items.slice(start, start + maxVisible).map((item, offset) => {
			const index = start + offset;
			const prefix = index === this.selectedItemIndex ? this.theme.fg("accent", "→ ") : "  ";
			const barLength = Math.ceil((item.tokens / maxTokens) * BAR_MAX_WIDTH);
			const prefixPart = `${prefix}${this.theme.fg("success", formatNumber(item.tokens).padStart(TOKEN_WIDTH))} ${this.theme.fg("accent", "█".repeat(barLength))}${this.theme.fg("dim", "░".repeat(BAR_MAX_WIDTH - barLength))}  `;
			return prefixPart + truncateToWidth(this.theme.fg("text", chartItemLabel(chart, item)), Math.max(0, width - (2 + TOKEN_WIDTH + 1 + BAR_MAX_WIDTH + 2)));
		});
		if (chart.items.length > maxVisible) lines.push(this.theme.fg("dim", truncateToWidth(`  (${this.selectedItemIndex + 1}/${chart.items.length})`, width, "")));
		return lines;
	}

	private renderSelectionDetail(chart: BloatChart): string {
		const item = chart.items[this.selectedItemIndex];
		if (!item) return this.theme.fg("dim", "No resource selected");
		const source = item.sourceTokens === undefined ? "" : ` · source size ~${formatNumber(item.sourceTokens)} tokens`;
		return `${this.theme.fg("success", `${formatNumber(item.tokens)} tokens`)}  ${this.theme.fg("muted", chartItemLabel(chart, item))}  ${this.theme.fg("dim", `${item.note}${source} · ${item.path}`)}`;
	}
}

class TokenBloatSettingsModal implements Component {
	private showSummaryOnOnboarding: boolean;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		initialConfig: TokenBloatConfig,
		private readonly done: (result: TokenBloatConfig | undefined) => void,
	) {
		this.showSummaryOnOnboarding = initialConfig.showSummaryOnOnboarding;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "left") || matchesKey(data, "right") || data === " ") {
			this.showSummaryOnOnboarding = !this.showSummaryOnOnboarding;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.done({ showSummaryOnOnboarding: this.showSummaryOnOnboarding });
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done(undefined);
	}

	render(width: number): string[] {
		const enabledText = this.showSummaryOnOnboarding ? this.theme.fg("success", "Enabled") : this.theme.fg("muted", "Disabled");
		return frame(
			[
				this.theme.fg("accent", this.theme.bold("TokenBloat settings")),
				this.theme.fg("dim", "Configure how TokenBloat appears when Pi starts."),
				"",
				`${this.theme.fg("text", "Startup summary")}  ${enabledText}`,
				this.theme.fg("dim", "Show the TokenBloat summary on startup and reload."),
				"",
				this.theme.fg("dim", "←/→ or Space toggle · Enter save · Esc cancel"),
			],
			Math.max(1, width - 4),
			this.theme,
		);
	}

	invalidate(): void {}
}

function frame(content: string[], innerWidth: number, theme: Theme): string[] {
	const blue = (text: string) => theme.fg("accent", text);
	const lines = [blue(`┌${"─".repeat(innerWidth)}┐`)];
	for (const line of content) {
		const truncated = truncateToWidth(line, innerWidth, "");
		lines.push(`${blue("│ ")}${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}${blue(" │")}`);
	}
	lines.push(blue(`└${"─".repeat(innerWidth)}┘`));
	return lines;
}

async function showTokenBloatModal(ctx: CustomUiContext, report: TokenBloatReport): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TokenBloatModal(tui, report, theme, done), {
		overlay: true,
		overlayOptions: { width: "90%", minWidth: 70, maxHeight: "80%", anchor: "center" },
	});
}

async function showTokenBloatSettingsModal(ctx: CustomUiContext, config: TokenBloatConfig): Promise<TokenBloatConfig | undefined> {
	return ctx.ui.custom<TokenBloatConfig | undefined>((tui, theme, _keybindings, done) => new TokenBloatSettingsModal(tui, theme, config, done), {
		overlay: true,
		overlayOptions: { width: "70%", minWidth: 58, maxHeight: "60%", anchor: "center" },
	});
}

export default function (pi: ExtensionAPI) {
	let summaryTimer: ReturnType<typeof setTimeout> | undefined;
	let cachedReport: TokenBloatReport | undefined;
	let lastSystemPrompt: string | undefined;
	let lastProviderPayloadTokens: number | undefined;
	let lastContextFiles: Array<{ path: string; content: string }> = [];

	function clearSummary(ctx: { ui: { setWidget: (key: string, content: string[] | undefined, options?: unknown) => void } }): void {
		if (summaryTimer) clearTimeout(summaryTimer);
		summaryTimer = undefined;
		ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined);
	}

	function showSummary(ctx: { ui: { setWidget: (key: string, content: string[] | undefined, options?: unknown) => void; theme: Theme } }, report: TokenBloatReport): void {
		if (summaryTimer) clearTimeout(summaryTimer);
		ctx.ui.setWidget(SUMMARY_WIDGET_KEY, renderTokenBloat(report, ctx.ui.theme), { placement: "aboveEditor" });
		summaryTimer = setTimeout(() => {
			ctx.ui.setWidget(SUMMARY_WIDGET_KEY, undefined);
			summaryTimer = undefined;
		}, SUMMARY_VISIBLE_MS);
	}

	async function loadReport(cwd: string, systemPrompt = lastSystemPrompt): Promise<TokenBloatReport> {
		cachedReport = await collectTokenBloat(cwd, pi, systemPrompt, lastContextFiles);
		cachedReport.providerPayloadTokens = lastProviderPayloadTokens;
		return cachedReport;
	}

	pi.on("session_start", async (event, ctx) => {
		lastSystemPrompt = ctx.getSystemPrompt();
		if (!ctx.hasUI) return;
		const config = readTokenBloatConfig();
		if (!config.showSummaryOnOnboarding) {
			clearSummary(ctx);
			return;
		}
		const report = await loadReport(ctx.cwd);
		if (event.reason === "startup" || event.reason === "reload") showSummary(ctx, report);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastSystemPrompt = event.systemPrompt;
		lastContextFiles = event.systemPromptOptions.contextFiles ?? [];
		cachedReport = await collectTokenBloat(ctx.cwd, pi, lastSystemPrompt, lastContextFiles);
	});

	pi.on("before_provider_request", (event) => {
		lastProviderPayloadTokens = tokenCount(JSON.stringify(event.payload));
		if (cachedReport) cachedReport.providerPayloadTokens = lastProviderPayloadTokens;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) clearSummary(ctx);
	});

	pi.registerCommand("token-bloat", {
		description: "Show LLM context footprint",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/token-bloat requires interactive mode", "error");
				return;
			}
			lastSystemPrompt = ctx.getSystemPrompt();
			await showTokenBloatModal(ctx, await loadReport(ctx.cwd));
		},
	});

	pi.registerCommand("token-bloat:settings", {
		description: "Configure TokenBloat",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/token-bloat:settings requires interactive mode", "error");
				return;
			}
			const nextConfig = await showTokenBloatSettingsModal(ctx, readTokenBloatConfig());
			if (!nextConfig) return;
			writeTokenBloatConfig(nextConfig);
			if (nextConfig.showSummaryOnOnboarding) showSummary(ctx, cachedReport ?? (await loadReport(ctx.cwd)));
			else clearSummary(ctx);
			ctx.ui.notify(`TokenBloat startup summary ${nextConfig.showSummaryOnOnboarding ? "enabled" : "disabled"}`, "info");
		},
	});
}
