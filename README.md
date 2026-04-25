# TokenBloat

TokenBloat is a Pi extension that shows the startup token footprint for loaded skills, prompts, and extensions.

Pi can load many resources before the first user message. TokenBloat makes that cost visible in the header and gives you an interactive chart for finding the largest resources.

![TokenBloat demo](assets/token-bloat-demo.gif)

## Features

- Adds a compact startup summary to the Pi header.
- Shows total tokens and files by resource group.
- Provides `/token-bloat` for an interactive chart.
- Defaults to an `All` chart across skills, prompts, and extensions.
- Keeps per-group charts for focused inspection.

## Install

Install from npm:

```bash
pi install npm:@ocodista/pi-token-bloat
```

Install from GitHub:

```bash
pi install git:github.com/ocodista/pi-token-bloat
```

Try it without installing:

```bash
pi -e git:github.com/ocodista/pi-token-bloat
```

## Use

Start Pi after installing the package. TokenBloat updates the startup header automatically. After `/reload`, it briefly shows the summary above the editor.

Open the detailed view:

```text
/token-bloat
```

Configure the startup summary:

```text
/token-bloat:settings
```

In the chart:

- Use `↑` and `↓` to move.
- Use `←`, `→`, or `Tab` to switch charts.
- Use number keys to jump to a chart.
- Press `Enter` or `Esc` to close.

## Development

Run a local copy directly:

```bash
pi -e ./index.ts
```

Check the npm package contents:

```bash
npm run pack:dry-run
```

Run TypeScript locally after installing dev dependencies:

```bash
npm install
npm run typecheck
```

## Security

Pi extensions run with your system permissions. Review packages before installing them.
