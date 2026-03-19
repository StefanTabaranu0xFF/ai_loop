#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SYSTEM_PROMPT = `You are an autonomous coding agent.
You must produce a complete C# solution that satisfies the user's goal.
Always respond with JSON matching this shape:
{
  "summary": "short description",
  "files": [
    {"path": "relative/path.csproj", "content": "..."},
    {"path": "relative/Program.cs", "content": "..."}
  ],
  "notes": ["optional bullet", "optional bullet"]
}
Rules:
- Only write files that are needed for the solution.
- Paths must be relative and must stay inside the workspace.
- Prefer using an SDK-style .NET project.
- Include tests when the goal can be tested.
- When OpenLab files are provided, use them as input contracts or fixture content.
- Never wrap the JSON in markdown fences.`;

const DEFAULT_BUILD_COMMANDS = ['dotnet build', 'dotnet test --no-build'];
const DEFAULT_RUN_COMMAND = 'dotnet run --no-build';

function parseArgs(argv) {
  const options = {
    model: 'gemma3:12b',
    workspace: './generated_solution',
    openlabPath: null,
    maxIterations: 3,
    ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    buildCommands: [],
    runCommand: DEFAULT_RUN_COMMAND,
    successSubstring: null,
    fileLimit: 12,
    dryRun: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--model') {
      options.model = argv[++index];
      continue;
    }
    if (arg === '--workspace') {
      options.workspace = argv[++index];
      continue;
    }
    if (arg === '--openlab-path') {
      options.openlabPath = argv[++index];
      continue;
    }
    if (arg === '--max-iterations') {
      options.maxIterations = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (arg === '--ollama-host') {
      options.ollamaHost = argv[++index];
      continue;
    }
    if (arg === '--build-command') {
      options.buildCommands.push(argv[++index]);
      continue;
    }
    if (arg === '--run-command') {
      options.runCommand = argv[++index];
      continue;
    }
    if (arg === '--success-substring') {
      options.successSubstring = argv[++index];
      continue;
    }
    if (arg === '--file-limit') {
      options.fileLimit = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (options.help) {
    return { help: true };
  }

  if (positional.length === 0) {
    throw new Error('A goal argument is required.');
  }

  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
    throw new Error('--max-iterations must be a positive integer.');
  }
  if (!Number.isInteger(options.fileLimit) || options.fileLimit < 1) {
    throw new Error('--file-limit must be a positive integer.');
  }

  return {
    goal: positional.join(' '),
    model: options.model,
    workspace: path.resolve(options.workspace),
    openlabPath: options.openlabPath ? path.resolve(options.openlabPath) : null,
    maxIterations: options.maxIterations,
    ollamaHost: options.ollamaHost.replace(/\/$/, ''),
    buildCommands: options.buildCommands.length > 0 ? options.buildCommands : [...DEFAULT_BUILD_COMMANDS],
    runCommand: options.runCommand && options.runCommand.trim() ? options.runCommand.trim() : null,
    successSubstring: options.successSubstring,
    fileLimit: options.fileLimit,
    dryRun: options.dryRun,
  };
}

function helpText() {
  return `Usage: node ai_loop.js [options] <goal>

Goal-driven loop for generating, building, running, and validating C# code with Ollama.

Options:
  --model <name>               Ollama model name (default: gemma3:12b)
  --workspace <path>           Directory where generated files are written
  --openlab-path <path>        OpenLab directory or file to inline into the prompt
  --max-iterations <n>         Maximum repair iterations (default: 3)
  --ollama-host <url>          Base URL for Ollama (default: http://127.0.0.1:11434)
  --build-command <command>    Build/test command; repeat for multiple steps
  --run-command <command>      Run command after build/test; use empty string to skip
  --success-substring <text>   Require runtime output to contain this text
  --file-limit <n>             Maximum OpenLab files to inline (default: 12)
  --dry-run                    Print the constructed prompt and exit
  -h, --help                   Show this help text`;
}

function gatherOpenLabContext(openlabPath, limit) {
  if (!openlabPath) {
    return 'No OpenLab files were provided.';
  }

  if (!fs.existsSync(openlabPath)) {
    throw new Error(`OpenLab path does not exist: ${openlabPath}`);
  }

  const stat = fs.statSync(openlabPath);
  const files = stat.isFile()
    ? [openlabPath]
    : walkFiles(openlabPath).sort((left, right) => left.localeCompare(right));

  const basePath = stat.isFile() ? path.dirname(openlabPath) : openlabPath;
  const snippets = files.slice(0, limit).map((filePath) => {
    const buffer = fs.readFileSync(filePath);
    const content = isProbablyText(buffer)
      ? buffer.toString('utf8')
      : `<binary file omitted: ${path.basename(filePath)}>`;
    return `FILE: ${path.relative(basePath, filePath)}\n${content.slice(0, 12000)}`;
  });

  const remaining = Math.max(files.length - limit, 0);
  const suffix = remaining > 0 ? `\n... ${remaining} additional file(s) omitted.` : '';
  return `${snippets.join('\n\n')}${suffix}`;
}

function walkFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(resolved);
    }
    return entry.isFile() ? [resolved] : [];
  });
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function buildUserPrompt(config, openlabContext, feedback) {
  const prompt = [
    'Goal:',
    config.goal,
    '',
    'Constraints:',
    `- Target workspace: ${config.workspace}`,
    `- Produce a C# project that can be built with these commands: ${JSON.stringify(config.buildCommands)}`,
    `- Run command after build/test: ${config.runCommand || 'skip'}`,
    `- Success substring requirement: ${config.successSubstring || 'none'}`,
    '',
    'OpenLab context:',
    openlabContext,
  ].join('\n');

  return feedback ? `${prompt}\n\nPrevious execution feedback:\n${feedback.trim()}` : prompt;
}

async function callOllama(host, model, prompt) {
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to contact Ollama at ${host}: ${response.status} ${response.statusText}`);
  }

  const raw = await response.json();
  const content = raw?.message?.content;
  if (!content) {
    throw new Error(`Ollama response did not include message content: ${JSON.stringify(raw)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Model response was not valid JSON: ${content}`);
  }

  validateModelResponse(parsed);
  return parsed;
}

function validateModelResponse(payload) {
  if (!payload || !Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error("Model response must include a non-empty 'files' list.");
  }

  for (const item of payload.files) {
    if (!item || typeof item !== 'object') {
      throw new Error('Each files entry must be an object.');
    }
    if (typeof item.path !== 'string' || typeof item.content !== 'string') {
      throw new Error("Each file entry must include string 'path' and 'content'.");
    }
  }
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside workspace: ${relativePath}`);
  }
  return candidate;
}

function writeFiles(root, files) {
  fs.mkdirSync(root, { recursive: true });
  return files.map((entry) => {
    const destination = safeJoin(root, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.content, 'utf8');
    return destination;
  });
}

function runCommand(command, cwd) {
  const completed = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
  });

  return {
    command,
    returncode: completed.status ?? 1,
    stdout: completed.stdout || '',
    stderr: completed.stderr || (completed.error ? String(completed.error) : ''),
    combinedOutput() {
      return [this.stdout.trim(), this.stderr.trim()].filter(Boolean).join('\n');
    },
  };
}

function runValidation(config) {
  const results = [];
  for (const command of config.buildCommands) {
    const result = runCommand(command, config.workspace);
    results.push(result);
    if (result.returncode !== 0) {
      return { success: false, results };
    }
  }

  if (config.runCommand) {
    const result = runCommand(config.runCommand, config.workspace);
    results.push(result);
    if (result.returncode !== 0) {
      return { success: false, results };
    }
    if (config.successSubstring && !result.combinedOutput().includes(config.successSubstring)) {
      return { success: false, results };
    }
  }

  return { success: true, results };
}

function formatResults(results) {
  return results.map((result) => [
    `COMMAND: ${result.command}`,
    `EXIT CODE: ${result.returncode}`,
    'STDOUT:',
    result.stdout.trim() || '<empty>',
    'STDERR:',
    result.stderr.trim() || '<empty>',
  ].join('\n')).join('\n\n');
}

function saveArtifacts(config, prompt, response, results) {
  const metaDir = path.join(config.workspace, '.ai_loop');
  fs.mkdirSync(metaDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(metaDir, `prompt-${timestamp}.txt`), prompt, 'utf8');
  fs.writeFileSync(path.join(metaDir, `response-${timestamp}.json`), JSON.stringify(response, null, 2), 'utf8');
  if (results.length > 0) {
    fs.writeFileSync(path.join(metaDir, `results-${timestamp}.txt`), formatResults(results), 'utf8');
  }
}

async function executeLoop(config, dependencies = {}) {
  const {
    gatherOpenLabContextImpl = gatherOpenLabContext,
    buildUserPromptImpl = buildUserPrompt,
    callOllamaImpl = callOllama,
    writeFilesImpl = writeFiles,
    runValidationImpl = runValidation,
    saveArtifactsImpl = saveArtifacts,
    logger = console,
  } = dependencies;

  const openlabContext = gatherOpenLabContextImpl(config.openlabPath, config.fileLimit);
  let feedback = null;

  if (config.dryRun) {
    logger.log(buildUserPromptImpl(config, openlabContext, feedback));
    return 0;
  }

  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    const prompt = buildUserPromptImpl(config, openlabContext, feedback);
    const response = await callOllamaImpl(config.ollamaHost, config.model, prompt);
    writeFilesImpl(config.workspace, response.files);
    const { success, results } = runValidationImpl(config);
    saveArtifactsImpl(config, prompt, response, results);

    logger.log(`Iteration ${iteration}/${config.maxIterations}: ${response.summary || 'no summary'}`);
    logger.log(results.length > 0 ? formatResults(results) : 'No commands were executed.');

    if (success) {
      logger.log('Goal achieved.');
      return 0;
    }

    feedback = [
      'The previous attempt did not meet the goal. Fix the project and return a full replacement set of changed files.',
      '',
      formatResults(results),
    ].join('\n');
  }

  logger.error('Maximum iterations reached without satisfying the goal.');
  return 1;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(helpText());
      return 0;
    }
    return await executeLoop(parsed);
  } catch (error) {
    console.error(`ai_loop failed: ${error.message}`);
    return 1;
  }
}

module.exports = {
  DEFAULT_BUILD_COMMANDS,
  DEFAULT_RUN_COMMAND,
  SYSTEM_PROMPT,
  buildUserPrompt,
  callOllama,
  executeLoop,
  formatResults,
  gatherOpenLabContext,
  helpText,
  parseArgs,
  runCommand,
  runValidation,
  safeJoin,
  saveArtifacts,
  validateModelResponse,
  walkFiles,
  writeFiles,
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
