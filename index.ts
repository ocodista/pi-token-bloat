import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export type BloatSectionName = "Skills" | "Prompts" | "Extensions";

export interface BloatItem {
	section: BloatSectionName;
	label: string;
	path: string;
	chars: number;
	tokens: number;
}

export interface BloatSection {
	name: BloatSectionName;
	files: number;
	chars: number;
	tokens: number;
	items: BloatItem[];
}

export interface TokenBloatReport {
	sections: BloatSection[];
	totalFiles: number;
	totalChars: number;
	totalTokens: number;
}

export interface TokenBloatConfig {
	showSummaryOnOnboarding: boolean;
}

const TOKEN_DIVISOR = 4;
const CONFIG_FILE_NAME = "token-bloat.json";
const SUMMARY_WIDGET_KEY = "token-bloat-summary";
const SUMMARY_VISIBLE_MS = 10_000;
const DEFAULT_CONFIG: TokenBloatConfig = {
	showSummaryOnOnboarding: true,
};

function tokenCount(chars: number): number {
	return chars / TOKEN_DIVISOR;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US", {
		maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
	}).format(value);
}

function readCharCount(filePath: string): number {
	try {
		if (!existsSync(filePath)) return 0;
		if (!statSync(filePath).isFile()) return 0;
		return readFileSync(filePath, "utf-8").length;
	} catch {
		return 0;
	}
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
			showSummaryOnOnboarding:
				typeof parsed.showSummaryOnOnboarding === "boolean" ? parsed.showSummaryOnOnboarding : DEFAULT_CONFIG.showSummaryOnOnboarding,
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

function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}

function expandSkillPath(resourcePath: string): string[] {
	try {
		if (!statSync(resourcePath).isDirectory()) return [resourcePath];
		const skillPath = join(resourcePath, "SKILL.md");
		return existsSync(skillPath) ? [skillPath] : [];
	} catch {
		return [resourcePath];
	}
}

function expandPromptPath(resourcePath: string): string[] {
	try {
		if (!statSync(resourcePath).isDirectory()) return [resourcePath];
		return readdirSync(resourcePath)
			.filter((entry) => entry.endsWith(".md"))
			.map((entry) => join(resourcePath, entry));
	} catch {
		return [resourcePath];
	}
}

function expandExtensionPath(resourcePath: string): string[] {
	try {
		if (!statSync(resourcePath).isDirectory()) return [resourcePath];
		const indexTs = join(resourcePath, "index.ts");
		const indexJs = join(resourcePath, "index.js");
		if (existsSync(indexTs)) return [indexTs];
		if (existsSync(indexJs)) return [indexJs];
		return [];
	} catch {
		return [resourcePath];
	}
}

function labelForPath(sectionName: BloatSectionName, filePath: string): string {
	if (sectionName === "Skills") return basename(filePath) === "SKILL.md" ? basename(dirname(filePath)) : basename(filePath, extname(filePath));
	if (sectionName === "Prompts") return `/${basename(filePath, extname(filePath))}`;
	if (basename(filePath) === "index.ts" || basename(filePath) === "index.js") return basename(dirname(filePath));
	return basename(filePath, extname(filePath));
}

function buildSection(name: BloatSectionName, paths: string[]): BloatSection {
	const items = uniquePaths(paths)
		.map((filePath) => {
			const chars = readCharCount(filePath);
			return {
				section: name,
				label: labelForPath(name, filePath),
				path: filePath,
				chars,
				tokens: tokenCount(chars),
			};
		})
		.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
	const chars = items.reduce((sum, item) => sum + item.chars, 0);
	return { name, files: items.length, chars, tokens: tokenCount(chars), items };
}

async function collectTokenBloat(cwd: string): Promise<TokenBloatReport> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const paths = await packageManager.resolve();
	const enabledPaths = (resources: typeof paths.skills): string[] => resources.filter((resource) => resource.enabled).map((resource) => resource.path);
	const sections = [
		buildSection("Skills", enabledPaths(paths.skills).flatMap(expandSkillPath)),
		buildSection("Prompts", enabledPaths(paths.prompts).flatMap(expandPromptPath)),
		buildSection("Extensions", enabledPaths(paths.extensions).flatMap(expandExtensionPath)),
	];
	const totalFiles = sections.reduce((sum, section) => sum + section.files, 0);
	const totalChars = sections.reduce((sum, section) => sum + section.chars, 0);
	return { sections, totalFiles, totalChars, totalTokens: tokenCount(totalChars) };
}

function renderTokenBloat(report: TokenBloatReport, theme: Theme): string[] {
	const muted = (text: string) => theme.fg("dim", text);
	const sectionLine = (section: BloatSection): string =>
		`  ${theme.fg("accent", section.name)} ${muted(`${formatNumber(section.files)} files, ${formatNumber(section.tokens)} tokens`)}`;
	return [
		theme.fg("mdHeading", "[TokenBloat]"),
		...report.sections.map(sectionLine),
		muted(`  Total ${formatNumber(report.totalFiles)} files, ${formatNumber(report.totalTokens)} tokens`),
	];
}

export default function (pi: ExtensionAPI) {
	let summaryTimer: ReturnType<typeof setTimeout> | undefined;
	let cachedReport: TokenBloatReport | undefined;

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

	async function loadReport(cwd: string): Promise<TokenBloatReport> {
		cachedReport = await collectTokenBloat(cwd);
		return cachedReport;
	}

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const config = readTokenBloatConfig();
		if (!config.showSummaryOnOnboarding) {
			clearSummary(ctx);
			return;
		}
		const report = await loadReport(ctx.cwd);
		if (event.reason === "startup" || event.reason === "reload") showSummary(ctx, report);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		clearSummary(ctx);
	});

	pi.registerCommand("token-bloat", {
		description: "Show startup token footprint",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/token-bloat requires interactive mode", "error");
				return;
			}
			const report = cachedReport ?? (await loadReport(ctx.cwd));
			const { showTokenBloatModal } = await import("./ui.ts");
			await showTokenBloatModal(ctx, report);
		},
	});

	pi.registerCommand("token-bloat:settings", {
		description: "Configure TokenBloat",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/token-bloat:settings requires interactive mode", "error");
				return;
			}
			const currentConfig = readTokenBloatConfig();
			const { showTokenBloatSettingsModal } = await import("./ui.ts");
			const nextConfig = await showTokenBloatSettingsModal(ctx, currentConfig);
			if (!nextConfig) return;
			writeTokenBloatConfig(nextConfig);
			if (nextConfig.showSummaryOnOnboarding) showSummary(ctx, cachedReport ?? (await loadReport(ctx.cwd)));
			else clearSummary(ctx);
			ctx.ui.notify(`TokenBloat startup summary ${nextConfig.showSummaryOnOnboarding ? "enabled" : "disabled"}`, "info");
		},
	});
}
