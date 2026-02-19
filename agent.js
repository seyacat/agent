#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { exec } from "child_process";
import dotenv from "dotenv";
import OpenAI from "openai";
import simpleGit from "simple-git";
import { encode } from "gpt-tokenizer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// Token counting and compression
const MAX_TOKENS = 6000;
const MAX_MESSAGES = 20;

function countTokens(text) {
  return encode(text).length;
}

function countMessageTokens(message) {
  return countTokens(`${message.role}: ${message.content}`);
}

function totalTokens() {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
}

function compressContext() {
  let tokens = totalTokens();
  if (tokens <= MAX_TOKENS && messages.length <= MAX_MESSAGES) {
    return;
  }
  // Keep system message and the most recent messages
  const system = messages[0];
  const recent = messages.slice(-MAX_MESSAGES + 1); // +1 because we'll add system back
  messages = [system, ...recent];
  // If still over token limit, remove oldest non‑system messages
  while (totalTokens() > MAX_TOKENS && messages.length > 2) {
    messages.splice(1, 1); // remove the oldest after system
  }
  console.log("🔧 Context compressed.");
}

const AUTO_APPROVE = process.env.AUTO_APPROVE === "true";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com"
});

const git = simpleGit();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Detect OS and shell information
const osPlatform = process.platform;
const isWindows = osPlatform === 'win32';
const shellType = process.env.SHELL || (isWindows ? 'cmd.exe' : 'bash');
const osInfo = isWindows ? 'Windows' : osPlatform === 'darwin' ? 'macOS' : 'Linux';

let messages = [
  {
    role: "system",
    content: `
You are an autonomous coding agent that can execute any shell command, read/write files, and commit changes.

You are working in directory: ${process.cwd()}
Operating System: ${osInfo} (${osPlatform})
Shell: ${shellType}
${isWindows ? 'IMPORTANT: You are on Windows. Use Windows commands: "dir" instead of "ls", "del" instead of "rm", "copy" instead of "cp", "move" instead of "mv". Use "cmd.exe" syntax.' : 'IMPORTANT: You are on Unix-like system. Use standard Unix commands.'}

CRITICAL TASK EXECUTION RULES:
1. When given a task, you must complete it fully before stopping.
2. Break complex tasks into multiple steps and execute them sequentially.
3. During task execution, ALWAYS respond with JSON commands. Do not switch to normal conversation until the task is 100% complete.
4. After each command execution, assess if the task is complete. If not, immediately provide the next JSON command.
5. Only return to normal conversation (text responses) when the task is fully completed and verified.

ACTION FORMAT - Respond ONLY in JSON during task execution:

Run command: { "action": "run", "command": "..." }
Read file: { "action": "read", "file": "..." }
Apply patch: { "action": "patch", "file": "...", "content": "full new content" }
Commit: { "action": "commit", "message": "..." }

EXAMPLE TASK "create and list files":
1. First JSON: { "action": "run", "command": "echo Hello > test.txt" } to create a file
2. After creation, next JSON: { "action": "run", "command": "dir" } to list files and verify
3. Only after verification, respond with text: "Task completed: test.txt created and verified"

Keep responses concise. The context window is limited; if the conversation grows too long, older messages will be compressed.
`
  }
];

function ask(q) {
  return new Promise(res => rl.question(q, res));
}

function runCommand(command, maxRetries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (retryCount = 0) => {
      exec(command, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (retryCount < maxRetries) {
            console.log(`⚠ Command failed, retrying (${retryCount + 1}/${maxRetries})...`);
            setTimeout(() => attempt(retryCount + 1), 1000 * (retryCount + 1));
          } else {
            resolve({
              success: false,
              output: stderr || err.message,
              error: err,
              command: command
            });
          }
        } else {
          resolve({
            success: true,
            output: stdout,
            error: null,
            command: command
          });
        }
      });
    };
    attempt();
  });
}

async function applyPatch(file, content) {
  fs.writeFileSync(file, content);
  return `Patched ${file}`;
}

async function commitChanges(message) {
  await git.add(".");
  await git.commit(message);
  return "Committed changes.";
}

async function processInput(input, maxSteps = 10) {
  if (input === "/exit") process.exit(0);
  if (input === "/reset") {
    messages = [messages[0]];
    console.log("🔄 Context reset.");
    return;
  }
  if (input === "/pwd") {
    console.log(process.cwd());
    return;
  }

  messages.push({ role: "user", content: input });
  compressContext();

  let steps = 0;
  
  while (steps < maxSteps) {
    steps++;
    
    const stream = await client.chat.completions.create({
      model: "deepseek-chat",
      messages,
      stream: false
    });

    const reply = stream.choices[0].message.content;

    // Try to extract JSON from markdown code blocks
    let jsonMatch = reply.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    let jsonText = jsonMatch ? jsonMatch[1] : reply;
    
    // Also handle case where JSON is not in code blocks but is the entire response
    let parsed;
    try {
      parsed = JSON.parse(jsonText.trim());
    } catch {
      parsed = null;
    }

    // Always add the full reply to messages for context
    console.log("\n🤖 " + reply + "\n");
    messages.push({ role: "assistant", content: reply });
    
    if (!parsed) {
      compressContext();
      // If the response is not JSON, the LLM might be providing commentary
      // Continue the loop to see if it provides a JSON command next
      // But limit to avoid infinite loops on pure conversation
      if (reply.toLowerCase().includes("task complete") ||
          reply.toLowerCase().includes("finished") ||
          reply.toLowerCase().includes("done") ||
          reply.toLowerCase().includes("completed")) {
        // Task appears to be complete
        break;
      }
      // Otherwise continue to next iteration
      continue;
    }

    if (parsed.action === "run") {
      if (!AUTO_APPROVE) {
        const confirm = await ask(`⚠ Run "${parsed.command}"? (y/n): `);
        if (confirm !== "y") {
          // User declined, break out of task continuation
          break;
        }
      }

      const result = await runCommand(parsed.command);
      console.log(result.output);

      if (!result.success) {
        console.log(`❌ Command failed: ${result.command}`);
        messages.push({
          role: "assistant",
          content: `Command failed after retries: ${result.command}\nError: ${result.output}\nPlease suggest an alternative approach or fix the command.`
        });
      } else {
        messages.push({
          role: "assistant",
          content: `Command executed successfully:\n${result.output}`
        });
      }
      compressContext();
      
      // Continue to next step (don't return)
      continue;
    }

    if (parsed.action === "patch") {
      if (!AUTO_APPROVE) {
        const confirm = await ask(`⚠ Patch file "${parsed.file}"? (y/n): `);
        if (confirm !== "y") {
          break;
        }
      }

      const result = await applyPatch(parsed.file, parsed.content);
      console.log(result);

      messages.push({
        role: "assistant",
        content: result
      });
      compressContext();
      continue;
    }

    if (parsed.action === "commit") {
      const result = await commitChanges(parsed.message);
      console.log(result);

      messages.push({
        role: "assistant",
        content: result
      });
      compressContext();
      continue;
    }
    
    // Unknown action, break
    break;
  }
  
  if (steps >= maxSteps) {
    console.log("⚠ Maximum task steps reached. Returning to interactive mode.");
  }
}

async function loop() {
  const input = await ask("> ");
  await processInput(input);
  loop();
}

// Command-line argument handling
const args = process.argv.slice(2);
const interactive = args.includes("--interactive");
const initialInputs = args.filter(arg => arg !== "--interactive").join(" ");

if (initialInputs) {
  (async () => {
    await processInput(initialInputs);
    if (interactive) {
      console.log("🤖 Entering interactive mode...");
      loop();
    } else {
      process.exit(0);
    }
  })();
} else {
  console.log("🤖 DeepSeek Autonomous Agent Ready");
  console.log("Commands: /reset /exit /pwd");
  loop();
}
