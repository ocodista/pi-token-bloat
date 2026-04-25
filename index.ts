import {
	DefaultPackageManager,
	SettingsManager,
	VERSION,
	getAgentDir,
	keyHint,
	keyText,
	rawKeyHint,
	type ExtensionAPI,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Container, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

type BloatSectionName = "Skills" | "Prompts" | "Extensions";
type BloatChartName = "All" | BloatSectionName;
type BloatChartKind = "all" | "section";

interface BloatItem {
	section: BloatSectionName;
	label: string;
	path: string;
	chars: number;
	tokens: number;
}

interface BloatSection {
	name: BloatSectionName;
	files: number;
	chars: number;
	tokens: number;
	items: BloatItem[];
}

interface TokenBloatReport {
	sections: BloatSection[];
	totalFiles: number;
	totalChars: number;
	totalTokens: number;
}

interface BloatChart {
	name: BloatChartName;
	kind: BloatChartKind;
	files: number;
	chars: number;
	tokens: number;
	items: BloatItem[];
}

const TOKEN_DIVISOR = 4;
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
	if (sectionName === "Skills") {
		return basename(filePath) === "SKILL.md" ? basename(dirname(filePath)) : basename(filePath, extname(filePath));
	}
	if (sectionName === "Prompts") {
		return `/${basename(filePath, extname(filePath))}`;
	}
	if (basename(filePath) === "index.ts" || basename(filePath) === "index.js") {
		return basename(dirname(filePath));
	}
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
	return {
		name,
		files: items.length,
		chars,
		tokens: tokenCount(chars),
		items,
	};
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
	return {
		sections,
		totalFiles,
		totalChars,
		totalTokens: tokenCount(totalChars),
	};
}

function buildAllChart(sections: BloatSection[]): BloatChart {
	const items = sections.flatMap((section) => section.items).sort((a, b) => b.tokens - a.tokens || a.section.localeCompare(b.section) || a.label.localeCompare(b.label));
	const chars = items.reduce((sum, item) => sum + item.chars, 0);
	return {
		name: "All",
		kind: "all",
		files: items.length,
		chars,
		tokens: tokenCount(chars),
		items,
	};
}

function buildSectionChart(section: BloatSection): BloatChart {
	return {
		name: section.name,
		kind: "section",
		files: section.files,
		chars: section.chars,
		tokens: section.tokens,
		items: section.items,
	};
}

function buildCharts(sections: BloatSection[]): BloatChart[] {
	return [buildAllChart(sections), ...sections.map(buildSectionChart)];
}

function chartItemLabel(chart: BloatChart, item: BloatItem): string {
	if (chart.kind === "all") return `${item.section} · ${item.label}`;
	return item.label;
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

function renderInstructionBlock(theme: Theme, expanded: boolean): string[] {
	const compactInstructions = [
		keyHint("app.interrupt", "interrupt"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		keyHint("app.tools.expand", "more"),
	].join(theme.fg("muted", " · "));
	if (!expanded) {
		return [compactInstructions, theme.fg("dim", `Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`)];
	}
	return [
		keyHint("app.interrupt", "to interrupt"),
		keyHint("app.clear", "to clear"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		keyHint("app.exit", "to exit (empty)"),
		keyHint("app.suspend", "to suspend"),
		keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
		keyHint("app.thinking.cycle", "to cycle thinking level"),
		rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
		keyHint("app.model.select", "to select model"),
		keyHint("app.tools.expand", "to expand tools"),
		keyHint("app.thinking.toggle", "to expand thinking"),
		keyHint("app.editor.external", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		keyHint("app.message.followUp", "to queue follow-up"),
		keyHint("app.message.dequeue", "to edit all queued messages"),
		keyHint("app.clipboard.pasteImage", "to paste image"),
		rawKeyHint("drop files", "to attach"),
	];
}

function renderHeader(report: TokenBloatReport, theme: Theme, expanded: boolean): string[] {
	const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
	const onboarding = theme.fg("dim", "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.");
	return [logo, ...renderInstructionBlock(theme, expanded), "", onboarding, "", ...renderTokenBloat(report, theme)];
}

function createHeaderFactory(report: TokenBloatReport, isExpanded: () => boolean): (_tui: TUI, theme: Theme) => Component {
	return (_tui: TUI, theme: Theme) => ({
		render(_width: number): string[] {
			return renderHeader(report, theme, isExpanded());
		},
		invalidate() {},
	});
}

class BarList implements Component {
	private selectedIndex = 0;
	private readonly tokenWidth = 10;
	private readonly barMaxWidth = 14;

	constructor(
		private readonly items: BloatItem[],
		private readonly chartMaxTokens: number,
		private readonly theme: Theme,
		private readonly maxVisible: number,
		private readonly itemLabel: (item: BloatItem) => string,
		private readonly onSelectItem: () => void,
		private readonly onCancel: () => void,
		private readonly onChange: (item: BloatItem) => void,
	) {}

	handleInput(data: string): void {
		if (this.items.length === 0) {
			if (matchesKey(data, "enter")) this.onSelectItem();
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onCancel();
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
			this.onChange(this.items[this.selectedIndex]!);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
			this.onChange(this.items[this.selectedIndex]!);
			return;
		}
		if (matchesKey(data, "enter")) {
			this.onSelectItem();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onCancel();
		}
	}

	render(width: number): string[] {
		if (this.items.length === 0) {
			return [this.theme.fg("dim", "  No items")];
		}

		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const tokenStr = this.theme.fg("success", formatNumber(item.tokens).padStart(this.tokenWidth));
			const barLength = Math.max(0, Math.ceil((item.tokens / this.chartMaxTokens) * this.barMaxWidth));
			const barStr = this.theme.fg("accent", "█".repeat(barLength)) + this.theme.fg("dim", "░".repeat(this.barMaxWidth - barLength));
			const prefixPart = prefix + tokenStr + " " + barStr + "  ";
			const prefixVisible = 2 + this.tokenWidth + 1 + this.barMaxWidth + 2;
			const remaining = Math.max(0, width - prefixVisible);
			const labelStr = truncateToWidth(this.theme.fg("text", this.itemLabel(item)), remaining);
			lines.push(prefixPart + labelStr);
		}

		if (this.items.length > this.maxVisible) {
			const scrollInfo = `  (${this.selectedIndex + 1}/${this.items.length})`;
			lines.push(this.theme.fg("dim", truncateToWidth(scrollInfo, width, "")));
		}

		return lines;
	}

	invalidate(): void {}
}

class TokenBloatModal implements Component {
	private readonly charts: BloatChart[];
	private selectedChartIndex = 0;
	private list: BarList;
	private selectedItem: BloatItem | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly report: TokenBloatReport,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {
		this.charts = buildCharts(report.sections);
		this.list = this.createList(this.currentChart());
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.selectChart((this.selectedChartIndex + 1) % this.charts.length);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			this.selectChart((this.selectedChartIndex + this.charts.length - 1) % this.charts.length);
			this.tui.requestRender();
			return;
		}
		if (/^[1-9]$/.test(data)) {
			this.selectChart(Number(data) - 1);
			this.tui.requestRender();
			return;
		}
		this.list.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const chart = this.currentChart();
		const innerWidth = Math.max(1, width - 4);
		const container = new Container();
		const blue = (text: string) => this.theme.fg("accent", text);

		container.addChild(new Text(this.renderTitle(), 1, 0));
		container.addChild(new Text(this.renderSummary(), 1, 0));
		container.addChild(new Text(this.renderTabs(), 1, 0));
		container.addChild(new Text(this.renderChartMeta(chart), 1, 0));
		container.addChild(new Text(`${this.theme.fg("muted", "Tokens".padStart(10))}  ${this.theme.fg("muted", "─".repeat(14))}  ${this.theme.fg("muted", "Resource")}`, 1, 0));
		container.addChild(this.list);
		container.addChild(new Text(this.renderSelectionDetail(chart), 1, 0));
		container.addChild(new Text(this.theme.fg("dim", `↑↓ navigate · ←/→ or Tab switch chart · 1-${this.charts.length} jump · Enter/Esc close`), 1, 0));

		const content = container.render(innerWidth);
		const top = blue(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = blue(`└${"─".repeat(innerWidth)}┘`);
		const left = blue("│ ");
		const right = blue(" │");

		const lines: string[] = [top];
		for (const line of content) {
			const truncated = truncateToWidth(line, innerWidth, "");
			const vw = visibleWidth(truncated);
			const spaces = " ".repeat(Math.max(0, innerWidth - vw));
			lines.push(left + truncated + spaces + right);
		}
		lines.push(bottom);
		return lines;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private currentChart(): BloatChart {
		return this.charts[this.selectedChartIndex] ?? this.charts[0]!;
	}

	private selectChart(index: number): void {
		if (index < 0 || index >= this.charts.length) return;
		this.selectedChartIndex = index;
		this.list = this.createList(this.currentChart());
	}

	private createList(chart: BloatChart): BarList {
		const maxTokens = chart.items[0]?.tokens ?? 1;
		const list = new BarList(
			chart.items,
			maxTokens,
			this.theme,
			Math.min(Math.max(chart.items.length, 1), 12),
			(item) => chartItemLabel(chart, item),
			() => this.done(),
			() => this.done(),
			(item) => {
				this.selectedItem = item;
			},
		);
		this.selectedItem = chart.items[0];
		return list;
	}

	private renderTitle(): string {
		return `${this.theme.fg("accent", this.theme.bold("TokenBloat"))} ${this.theme.fg("dim", "startup token footprint")}`;
	}

	private renderSummary(): string {
		return this.theme.fg("dim", `Total ${formatNumber(this.report.totalTokens)} tokens across ${formatNumber(this.report.totalFiles)} resources`);
	}

	private renderTabs(): string {
		return this.charts
			.map((chart, index) => {
				const tab = `${index + 1}. ${chart.name} (${formatNumber(chart.files)}) ${formatNumber(chart.tokens)}`;
				if (index === this.selectedChartIndex) {
					return this.theme.bg("selectedBg", this.theme.fg("accent", ` ${this.theme.bold(tab)} `));
				}
				return this.theme.fg("dim", ` ${tab} `);
			})
			.join(" ");
	}

	private renderChartMeta(chart: BloatChart): string {
		const percent = this.report.totalTokens > 0 ? (chart.tokens / this.report.totalTokens) * 100 : 0;
		const labelHint = chart.kind === "all" ? "labels include resource group" : "resource labels";
		return `${this.theme.fg("accent", chart.name)} ${this.theme.fg(
			"dim",
			`${formatNumber(chart.files)} resources · ${formatNumber(chart.tokens)} tokens · ${formatNumber(percent)}% of total · sorted desc · ${labelHint}`,
		)}`;
	}

	private renderSelectionDetail(chart: BloatChart): string {
		if (!this.selectedItem) return this.theme.fg("dim", "No resource selected");
		return `${this.theme.fg("success", `${formatNumber(this.selectedItem.tokens)} tokens`)}  ${this.theme.fg(
			"muted",
			chartItemLabel(chart, this.selectedItem),
		)}  ${this.theme.fg("dim", this.selectedItem.path)}`;
	}
}

async function showTokenBloatModal(ctx: { ui: { custom: <T>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component, options?: unknown) => Promise<T> } }, report: TokenBloatReport): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new TokenBloatModal(tui, report, theme, done),
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				minWidth: 70,
				maxHeight: "80%",
				anchor: "center",
			},
		},
	);
}

export default function (pi: ExtensionAPI) {
	async function refreshTokenBloat(ctx: {
		cwd: string;
		ui: { setHeader: (factory: (_tui: TUI, theme: Theme) => Component) => void; getToolsExpanded: () => boolean; theme: Theme };
	}): Promise<TokenBloatReport> {
		const report = await collectTokenBloat(ctx.cwd);
		ctx.ui.setHeader(createHeaderFactory(report, ctx.ui.getToolsExpanded));
		return report;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await refreshTokenBloat(ctx);
	});

	pi.registerCommand("token-bloat", {
		description: "Open startup token footprint details for skills, prompts, and extensions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/token-bloat requires interactive mode", "error");
				return;
			}
			const report = await refreshTokenBloat(ctx);
			await showTokenBloatModal(ctx, report);
		},
	});
}
