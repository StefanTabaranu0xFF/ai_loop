# ai_loop

`ai_loop.js` is a goal-driven Node.js coding loop for local Ollama models such as `gemma3:12b`. It can:

- read input artifacts produced by OpenLab,
- analyze the files to infer likely format, record counts, and candidate fields,
- ask an Ollama model to generate or repair a C# solution,
- let the model request safe workspace-local bash commands or scripts,
- tolerate imperfect model responses by normalizing fenced JSON, alternate keys, file maps, and command-only plans,
- write the returned files into a workspace,
- compile, test, and optionally run the solution,
- feed the real command output back to the model until the goal is achieved or the retry limit is reached.

## How it works

1. You provide a goal, for example: "Generate C# code that reads OpenLab `.amx` files and prints a record summary".
2. `ai_loop.js` reads the files under `--openlab-path`, infers whether they look like XML, JSON, delimited text, key/value text, binary, or unknown `.amx` data, and extracts candidate field names and record estimates.
3. Each iteration includes the current workspace state, so the model can repair an existing generated solution instead of starting blind.
4. The model may return JSON containing files to write, workspace-local commands to run, or both.
5. The loop attempts to normalize common non-strict outputs as well, including fenced JSON, `write_files`, `project.files`, file maps, `bash`, `command`, or `steps` fields.
6. The generated files are written into `--workspace`, the requested commands are executed inside that workspace, and then validation runs.
7. Before running `dotnet build`, the loop checks that the model actually produced a `.csproj` or `.sln` file.
8. If validation fails, the exact structural/build/test/runtime output is sent back to the model for the next repair attempt.

## Requirements

- Node.js 18+
- A running Ollama server (default: `http://127.0.0.1:11434`)
- A .NET SDK installation for commands such as `dotnet build`, `dotnet test`, and `dotnet run`

## Example

```bash
node ai_loop.js \
  "Create a C# console app that reads all .amx files produced by OpenLab and prints the number of records and extracts information from the files." \
  --model gemma3:12b \
  --openlab-path ./openlab/Methods \
  --workspace ./generated_solution \
  --build-command "dotnet build" \
  --build-command "dotnet test --no-build" \
  --run-command "dotnet run --no-build" \
  --success-substring "records"
```

## Model response behavior

The model can now return files, commands, or both:

```json
{
  "summary": "Scaffold and implement the parser",
  "files": [
    {"path": "src/App.csproj", "content": "<Project Sdk=\"Microsoft.NET.Sdk\">...</Project>"},
    {"path": "src/Program.cs", "content": "using System; ..."}
  ],
  "commands": [
    {"command": "mkdir -p src/tests", "purpose": "prepare folders"},
    {"command": "bash scripts/setup.sh", "purpose": "run local setup script"}
  ],
  "notes": ["optional note"]
}
```

The loop also accepts common non-strict variants such as:

- fenced JSON blocks,
- `write_files` or `project.files`,
- file maps like `{ "Program.cs": "..." }`,
- `bash`, `command`, or `steps` for commands,
- command-only plans that scaffold the project before validation.

## Behavior improvements

- If `--openlab-path` is wrong, the CLI tries to suggest nearby matching directories from the current working tree.
- The OpenLab prompt context includes inferred file format, size, record estimates, candidate field names, and a preview or hex sample for each analyzed file.
- The prompt includes the current workspace file list so the model can repair incrementally.
- If the model forgets to generate a `.csproj` or `.sln`, the loop fails fast with a targeted repair message instead of only surfacing `MSB1003`.
- Model-requested commands are restricted to workspace-local execution and obvious dangerous commands such as `sudo` or `rm -rf /` are rejected.
- Imperfect model responses are normalized before validation so the loop is less brittle with smaller Ollama models.
- Network failures to Ollama include a clearer hint to check that Ollama is running and the requested model is installed.

## Notes

- The script writes prompts, model responses, and command results to `.ai_loop/` inside the workspace for inspection.
- The generated solution is constrained to stay inside the workspace directory.
- The repository includes Node.js tests for prompt construction, path safety, OpenLab ingestion, missing-path diagnostics, tolerant response normalization, workspace command execution, and loop orchestration helpers.
