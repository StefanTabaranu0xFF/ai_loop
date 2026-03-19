# ai_loop

`ai_loop.js` is a goal-driven Node.js coding loop for local Ollama models such as `gemma3:12b`. It can:

- read input artifacts produced by OpenLab,
- ask an Ollama model to generate or repair a C# solution,
- write the returned files into a workspace,
- compile, test, and optionally run the solution,
- feed the real command output back to the model until the goal is achieved or the retry limit is reached.

## How it works

1. You provide a goal, for example: "Generate C# code that reads OpenLab files and prints a summary".
2. `ai_loop.js` reads the files under `--openlab-path` and includes their contents in the model prompt.
3. The script calls the local Ollama HTTP API and requests a strict JSON response containing the files to write.
4. The generated files are written into `--workspace`.
5. The loop runs build and test commands such as `dotnet build` and `dotnet test --no-build`.
6. If validation fails, the exact compiler/test/runtime output is sent back to the model for the next repair attempt.

## Requirements

- Node.js 18+
- A running Ollama server (default: `http://127.0.0.1:11434`)
- A .NET SDK installation for commands such as `dotnet build`, `dotnet test`, and `dotnet run`

## Example

```bash
node ai_loop.js \
  "Create a C# console app that reads all .amx files produced by OpenLab and prints the number of records and extracts information from the files, the cli must also needs to know what kidnd of data is in the file" \
  --model gemma3:12b \
  --openlab-path ./openlab_output \
  --workspace ./generated_solution \
  --build-command "dotnet build" \
  --build-command "dotnet test --no-build" \
  --run-command "dotnet run --no-build" \
  --success-substring "records"
```

## Useful options

- `--dry-run`: print the fully constructed prompt without calling Ollama.
- `--build-command ...`: provide one or more validation commands.
- `--run-command ""`: skip the runtime execution step.
- `--max-iterations N`: control how many repair rounds the loop performs.
- `--file-limit N`: limit how many OpenLab files are inlined into the prompt.
- `--ollama-host URL`: point to a non-default Ollama server.

## Notes

- The script writes prompts, model responses, and command results to `.ai_loop/` inside the workspace for inspection.
- The generated solution is constrained to stay inside the workspace directory.
- The repository includes Node.js tests for prompt construction, path safety, OpenLab ingestion, and loop orchestration helpers.
