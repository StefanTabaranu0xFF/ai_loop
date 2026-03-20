'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aiLoop = require('../ai_loop');

function withTempDir(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-loop-'));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('gatherOpenLabContext reads a single file and reports inferred metadata', () => {
  withTempDir((root) => {
    const filePath = path.join(root, 'sample.amx');
    fs.writeFileSync(filePath, '<Records><Record><Name>A</Name></Record></Records>', 'utf8');
    const context = aiLoop.gatherOpenLabContext(filePath, 5);
    assert.match(context, /FILE: sample\.amx/);
    assert.match(context, /inferred_format: amx-xml-like/);
    assert.match(context, /candidate_fields: Records, Record, Name/);
  });
});

test('buildMissingPathMessage includes nearby suggestions when available', () => {
  withTempDir((root) => {
    const previousCwd = process.cwd();
    fs.mkdirSync(path.join(root, 'openlab', 'Methods'), { recursive: true });
    process.chdir(root);
    try {
      const message = aiLoop.buildMissingPathMessage(path.join(root, 'openlab_output'));
      assert.match(message, /OpenLab path does not exist/);
      assert.match(message, /openlab\/Methods/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('describeWorkspace reports generated files', () => {
  withTempDir((root) => {
    fs.writeFileSync(path.join(root, 'App.csproj'), '<Project />', 'utf8');
    fs.writeFileSync(path.join(root, 'Program.cs'), 'Console.WriteLine("hi");', 'utf8');
    const summary = aiLoop.describeWorkspace(root);
    assert.match(summary, /App\.csproj/);
    assert.match(summary, /Program\.cs/);
  });
});

test('extractJsonCandidate recovers fenced json payloads', () => {
  const candidate = aiLoop.extractJsonCandidate('Here is the plan:\n```json\n{"commands": ["mkdir -p src"]}\n```');
  assert.match(candidate, /mkdir -p src/);
});

test('normalizeModelResponse supports command-only responses', () => {
  const normalized = aiLoop.normalizeModelResponse({ command: 'mkdir -p src && dotnet new console --force' });
  assert.equal(normalized.files.length, 0);
  assert.equal(normalized.commands.length, 1);
});

test('normalizeModelResponse supports file maps', () => {
  const normalized = aiLoop.normalizeModelResponse({
    files: {
      'Program.cs': 'Console.WriteLine("hi");',
      'App.csproj': '<Project />',
    },
  });
  assert.equal(normalized.files.length, 2);
});

test('safeJoin rejects parent escape', () => {
  assert.throws(() => aiLoop.safeJoin('/tmp/workspace', '../evil.txt'), /outside workspace/);
});

test('buildUserPrompt appends feedback and workspace guidance', () => {
  const prompt = aiLoop.buildUserPrompt({
    goal: 'Build a parser',
    workspace: '/tmp/workspace',
    buildCommands: ['dotnet build'],
    runCommand: 'dotnet run',
    successSubstring: 'done',
  }, 'FILE: input.txt\n- inferred_format: csv', 'Workspace: /tmp/workspace\nVisible files: 0', 'compiler error');

  assert.match(prompt, /Build a parser/);
  assert.match(prompt, /compiler error/);
  assert.match(prompt, /Workspace state:/);
  assert.match(prompt, /command-only response is acceptable/);
});

test('validateModelResponse accepts command-only responses', () => {
  assert.doesNotThrow(() => aiLoop.validateModelResponse({
    files: [],
    commands: [{ command: 'mkdir -p src', purpose: 'setup' }],
  }));
});

test('parseAndNormalizeModelResponse tolerates fenced JSON and alternate keys', () => {
  const normalized = aiLoop.parseAndNormalizeModelResponse('```json\n{"write_files":{"Program.cs":"Console.WriteLine(\\"hi\\");"},"bash":"mkdir -p src"}\n```');
  assert.equal(normalized.files.length, 1);
  assert.equal(normalized.commands.length, 1);
});

test('validateWorkspaceCommand rejects dangerous commands', () => {
  assert.throws(() => aiLoop.validateWorkspaceCommand('sudo rm -rf /'), /Refusing dangerous command/);
});

test('runModelCommands executes workspace-local commands', () => {
  withTempDir((root) => {
    const result = aiLoop.runModelCommands({ workspace: root }, [
      { command: 'mkdir -p generated && printf hello > generated/out.txt', purpose: 'prepare fixture' },
    ]);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(root, 'generated', 'out.txt'), 'utf8'), 'hello');
    assert.match(result.results[0].stdout, /prepare fixture/);
  });
});

test('ensureBuildableProject reports missing .NET project files', () => {
  withTempDir((root) => {
    fs.writeFileSync(path.join(root, 'Program.cs'), 'Console.WriteLine("hi");', 'utf8');
    const result = aiLoop.ensureBuildableProject({ workspace: root, buildCommands: ['dotnet build'] });
    assert.equal(result.returncode, 1);
    assert.match(result.stdout, /No \.csproj or \.sln file was generated/);
  });
});

test('executeLoop runs model commands before validation', async () => {
  await new Promise((resolve, reject) => {
    withTempDir((root) => {
      const logs = [];
      aiLoop.executeLoop({
        goal: 'Say hello',
        model: 'gemma3:12b',
        workspace: root,
        openlabPath: null,
        maxIterations: 1,
        ollamaHost: 'http://127.0.0.1:11434',
        buildCommands: ['dotnet build'],
        runCommand: null,
        successSubstring: null,
        fileLimit: 3,
        dryRun: false,
      }, {
        callOllamaImpl: async () => ({
          summary: 'Created app',
          files: [
            { path: 'App.csproj', content: '<Project Sdk="Microsoft.NET.Sdk"></Project>' },
            { path: 'Program.cs', content: 'Console.WriteLine("hi");' },
          ],
          commands: [
            { command: 'mkdir -p generated && printf hello > generated/out.txt', purpose: 'prepare output' },
          ],
          notes: [],
        }),
        runValidationImpl: () => ({ success: true, results: [] }),
        logger: { log: (message) => logs.push(message), error: (message) => logs.push(message) },
      }).then((code) => {
        try {
          assert.equal(code, 0);
          assert.equal(fs.existsSync(path.join(root, 'generated', 'out.txt')), true);
          assert.match(logs.join('\n'), /Goal achieved/);
          resolve();
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
  });
});
