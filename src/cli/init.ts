import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readJsonFile(filePath: string): Record<string, any> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, any>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function getHookPath(): string {
  return path.resolve(__dirname, '..', '..', 'dist', 'hooks', 'user-prompt-submit.js');
}


function getLegacyHookPath(): string {
  return path.resolve(__dirname, '..', '..', 'hooks', 'user-prompt-submit.sh');
}

function getHookCommand(): string {
  return `node \"${getHookPath()}\"`;
}

function isRouterCommand(command: unknown): boolean {
  return typeof command === 'string' && (
    command === getHookCommand() ||
    command.includes(getHookPath()) ||
    command.includes(getLegacyHookPath())
  );
}

function isRouterHook(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }

  if ('command' in entry && isRouterCommand((entry as { command?: unknown }).command)) {
    return true;
  }

  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(isRouterHook);
}

function getRuntimeClaudeMdPath(): string {
  return path.resolve(__dirname, '..', '..', 'runtime-claude.md');
}

export function handleInit(args: string[]): void {
  try {
    console.log('ClaudeRouter init\n');

    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major < 18) {
      process.stderr.write(`Node.js ${process.versions.node} is too old — requires Node.js 18+\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ Node.js ${process.versions.node}`);

    const settingsPath = getSettingsPath();
    const hookPath = getHookPath();
    if (!fs.existsSync(hookPath)) {
      process.stderr.write(`Compiled hook not found at ${hookPath}. Run npm run build and try again.\n`);
      process.exitCode = 1;
      return;
    }

    const settings = readJsonFile(settingsPath);
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      settings.hooks = {};
    }
    if (!Array.isArray(settings.hooks.UserPromptSubmit)) {
      settings.hooks.UserPromptSubmit = [];
    }

    const hadRouterHook = settings.hooks.UserPromptSubmit.some(isRouterHook);
    settings.hooks.UserPromptSubmit = [
      ...settings.hooks.UserPromptSubmit.filter((entry: unknown) => !isRouterHook(entry)),
      {
        matcher: '',
        hooks: [{ type: 'command', command: getHookCommand() }],
      },
    ];
    writeJsonFile(settingsPath, settings);
    console.log(
      hadRouterHook
        ? 'Updated UserPromptSubmit hook in ~/.claude/settings.json'
        : 'Registered UserPromptSubmit hook in ~/.claude/settings.json',
    );

    const targetDir = args[0] || process.cwd();
    const targetClaudeMd = path.join(targetDir, 'CLAUDE.md');
    const runtimePath = getRuntimeClaudeMdPath();
    if (!fs.existsSync(runtimePath)) {
      process.stderr.write(`Runtime CLAUDE.md not found at ${runtimePath}\n`);
      process.exitCode = 1;
      return;
    }

    const routerContent = fs.readFileSync(runtimePath, 'utf-8');
    if (fs.existsSync(targetClaudeMd)) {
      let existing = fs.readFileSync(targetClaudeMd, 'utf-8');
      if (existing.includes('<!-- claude-router:start -->')) {
        existing = existing.replace(
          /<!-- claude-router:start -->[\s\S]*?<!-- claude-router:end -->/,
          routerContent.trim(),
        );
        fs.writeFileSync(targetClaudeMd, existing, 'utf-8');
        console.log(`Updated router directives in ${targetClaudeMd}`);
      } else {
        const separator = existing.endsWith('\n') ? '\n' : '\n\n';
        fs.writeFileSync(targetClaudeMd, existing + separator + routerContent, 'utf-8');
        console.log(`Appended router directives to ${targetClaudeMd}`);
      }
    } else {
      fs.writeFileSync(targetClaudeMd, routerContent, 'utf-8');
      console.log(`Created ${targetClaudeMd} with router directives`);
    }

    console.log('\nDone! ClaudeRouter is ready.');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error during init: ${message}\n`);
    process.exitCode = 1;
  }
}

export function handleRemove(args: string[]): void {
  try {
    console.log('ClaudeRouter remove\n');

    // 1. Remove the hook from settings.json
    const settingsPath = getSettingsPath();

    if (fs.existsSync(settingsPath)) {
      const settings = readJsonFile(settingsPath);

      if (settings.hooks && Array.isArray(settings.hooks.UserPromptSubmit)) {
        settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
          (entry: unknown) => !isRouterHook(entry),
        );

        if (settings.hooks.UserPromptSubmit.length === 0) {
          delete settings.hooks.UserPromptSubmit;
        }
        if (settings.hooks && Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }

        writeJsonFile(settingsPath, settings);
        console.log('Removed hook from ~/.claude/settings.json');
      } else {
        console.log('No hook found in ~/.claude/settings.json');
      }
    } else {
      console.log('No ~/.claude/settings.json found');
    }

    // 2. Remove CLAUDE.md section
    const targetDir = args[0] || process.cwd();
    const targetClaudeMd = path.join(targetDir, 'CLAUDE.md');

    if (fs.existsSync(targetClaudeMd)) {
      let content = fs.readFileSync(targetClaudeMd, 'utf-8');

      if (content.includes('<!-- claude-router:start -->')) {
        // Remove the block and any trailing blank line
        content = content.replace(
          /<!-- claude-router:start -->[\s\S]*?<!-- claude-router:end -->\n?/,
          ''
        );

        if (content.trim().length === 0) {
          fs.unlinkSync(targetClaudeMd);
          console.log(`Deleted empty ${targetClaudeMd}`);
        } else {
          fs.writeFileSync(targetClaudeMd, content, 'utf-8');
          console.log(`Removed router directives from ${targetClaudeMd}`);
        }
      } else {
        console.log(`No router directives found in ${targetClaudeMd}`);
      }
    } else {
      console.log(`No CLAUDE.md found at ${targetDir}`);
    }

    console.log('\nDone! ClaudeRouter has been removed.');
  } catch (err: any) {
    process.stderr.write(`Error during remove: ${err.message}\n`);
    process.exit(1);
  }
}
