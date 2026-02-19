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
  // Update system prompt to reflect current task state after compression
  updateSystemPrompt();
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

// Task management system
let tasks = {
  current: null,
  pending: [],    // Tasks waiting to be started
  active: [],     // Tasks currently in progress
  completed: []   // Finished tasks
};

function addTask(description, steps = []) {
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    description,
    steps,
    successCriteria: [], // Array of criteria that must be met for task completion
    verificationSteps: [], // Steps to verify each criterion
    status: 'pending', // 'pending', 'active', 'completed', 'failed'
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  tasks.pending.push(task);
  return task;
}

function addSuccessCriterion(taskId, criterion, verificationCommand = null) {
  const task = [...tasks.pending, ...tasks.active, ...tasks.completed]
    .find(t => t.id === taskId);
  if (!task) return false;
  
  task.successCriteria.push({
    criterion,
    verificationCommand,
    verified: false
  });
  task.updatedAt = new Date().toISOString();
  return true;
}

function verifyTaskCompletion(taskId) {
  const task = [...tasks.pending, ...tasks.active, ...tasks.completed]
    .find(t => t.id === taskId);
  if (!task) return false;
  
  // If no success criteria defined, cannot verify
  if (task.successCriteria.length === 0) return false;
  
  // Check if all criteria are verified
  const allVerified = task.successCriteria.every(c => c.verified === true);
  return allVerified;
}

function updateTaskStatus(taskId, status, result = null) {
  let task = null;
  
  // Search in all task arrays
  for (const category of ['pending', 'active', 'completed']) {
    const index = tasks[category].findIndex(t => t.id === taskId);
    if (index !== -1) {
      task = tasks[category][index];
      // Remove from current category
      tasks[category].splice(index, 1);
      break;
    }
  }
  
  if (!task) return null;
  
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (result) task.result = result;
  
  // Add to appropriate category
  if (status === 'pending') tasks.pending.push(task);
  else if (status === 'active') tasks.active.push(task);
  else if (status === 'completed' || status === 'failed') tasks.completed.push(task);
  
  return task;
}

function getActiveTask() {
  return tasks.active.length > 0 ? tasks.active[tasks.active.length - 1] : null;
}

function updateSystemPrompt() {
  // Update the system message with current task status
  const systemMessageIndex = messages.findIndex(msg => msg.role === "system");
  if (systemMessageIndex !== -1) {
    messages[systemMessageIndex].content = `
You are an autonomous coding agent that can execute any shell command, read/write files, and commit changes.

You are working in directory: ${process.cwd()}
Operating System: ${osInfo} (${osPlatform})
Shell: ${shellType}
${isWindows ? 'IMPORTANT: You are on Windows. Use Windows commands: "dir" instead of "ls", "del" instead of "rm", "copy" instead of "cp", "move" instead of "mv". Use "cmd.exe" syntax.' : 'IMPORTANT: You are on Unix-like system. Use standard Unix commands.'}

CRITICAL TASK EXECUTION RULES:
1. When given a task, you must complete it fully before stopping.
2. FIRST, define clear success criteria for the task. What constitutes successful completion?
3. Break complex tasks into multiple steps and execute them sequentially.
4. During task execution, ALWAYS respond with JSON commands. Do not switch to normal conversation until the task is 100% complete.
5. After each command execution, assess if the task is complete. If not, immediately provide the next JSON command.
6. Only return to normal conversation (text responses) when ALL success criteria have been objectively verified.

TASK MANAGEMENT SYSTEM:
- The agent maintains a task queue with status tracking
- Current active task: ${tasks.active.length > 0 ? tasks.active[tasks.active.length - 1].description : 'None'}
- Pending tasks: ${tasks.pending.length}
- Completed tasks: ${tasks.completed.length}

SUCCESS CRITERIA DEFINITION:
For each task, you should define 1-3 clear success criteria. Example for "delete file.txt":
1. Criterion: "file.txt no longer exists in the current directory"
   Verification: Run "dir" and check that file.txt is not in the output
2. Criterion: "No errors during deletion"
   Verification: Check that the delete command returned success

After defining criteria, execute verification steps to confirm each criterion is met.

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
`;
  }
}

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

TASK MANAGEMENT SYSTEM:
- The agent maintains a task queue with status tracking
- Current active task: None
- Pending tasks: 0
- Completed tasks: 0

ACTION FORMAT - Respond ONLY in JSON during task execution:

Define success criteria: { "action": "define_criteria", "taskId": "...", "criteria": ["criterion1", "criterion2"] }
Run command: { "action": "run", "command": "..." }
Read file: { "action": "read", "file": "..." }
Apply patch: { "action": "patch", "file": "...", "content": "full new content" }
Commit: { "action": "commit", "message": "..." }
Verify criterion: { "action": "verify", "taskId": "...", "criterionIndex": 0, "command": "..." }

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
    tasks = { current: null, pending: [], active: [], completed: [] };
    console.log("🔄 Context and tasks reset.");
    updateSystemPrompt();
    return;
  }
  if (input === "/pwd") {
    console.log(process.cwd());
    return;
  }
  if (input === "/tasks") {
    console.log("\n📋 Task Status:");
    console.log(`Active: ${tasks.active.length > 0 ? tasks.active.map(t => t.description).join(', ') : 'None'}`);
    console.log(`Pending: ${tasks.pending.length}`);
    console.log(`Completed: ${tasks.completed.length}`);
    return;
  }

  // Check if this looks like a new task (not a command or query)
  const isNewTask = !input.startsWith("/") &&
                   (input.length > 5 ||
                    input.toLowerCase().includes("create") ||
                    input.toLowerCase().includes("delete") ||
                    input.toLowerCase().includes("modify") ||
                    input.toLowerCase().includes("check"));
  
  let currentTask = null;
  if (isNewTask) {
    // Create a new task
    currentTask = addTask(input);
    updateTaskStatus(currentTask.id, 'active');
    console.log(`📝 New task created: "${input}" (ID: ${currentTask.id})`);
  } else {
    // Check if there's an active task
    currentTask = getActiveTask();
  }

  messages.push({ role: "user", content: input });
  updateSystemPrompt();
  compressContext();

  let steps = 0;
  
  while (steps < maxSteps) {
    steps++;
    console.log(`🔄 Step ${steps}/${maxSteps} - Current task: ${currentTask ? currentTask.description : 'None'}`);
    
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
      updateSystemPrompt();
      
      // Check if task has success criteria and all are verified
      if (currentTask && verifyTaskCompletion(currentTask.id)) {
        updateTaskStatus(currentTask.id, 'completed', reply);
        console.log(`🎯 Task completed and verified: "${currentTask.description}"`);
        break;
      }
      
      // Fallback: check if text indicates completion (for backward compatibility)
      if (reply.toLowerCase().includes("task complete") ||
          reply.toLowerCase().includes("finished") ||
          reply.toLowerCase().includes("done") ||
          reply.toLowerCase().includes("completed")) {
        // Mark task as completed only if no success criteria were defined
        if (currentTask && (!currentTask.successCriteria || currentTask.successCriteria.length === 0)) {
          updateTaskStatus(currentTask.id, 'completed', reply);
          console.log(`✅ Task completed: "${currentTask.description}"`);
          break;
        }
      }
      
      // Check if this is a failure
      if (reply.toLowerCase().includes("failed") ||
          reply.toLowerCase().includes("error") ||
          reply.toLowerCase().includes("cannot")) {
        if (currentTask) {
          updateTaskStatus(currentTask.id, 'failed', reply);
          console.log(`❌ Task failed: "${currentTask.description}"`);
        }
      }
      
      // Otherwise continue to next iteration
      continue;
    }

    if (parsed.action === "define_criteria") {
      if (currentTask && parsed.taskId === currentTask.id) {
        // Add success criteria to the task
        parsed.criteria.forEach((criterion, index) => {
          addSuccessCriterion(currentTask.id, criterion);
        });
        console.log(`📋 Defined ${parsed.criteria.length} success criteria for task`);
        messages.push({
          role: "assistant",
          content: `Success criteria defined for task: ${parsed.criteria.join('; ')}`
        });
      }
      compressContext();
      updateSystemPrompt();
      continue;
    }

    if (parsed.action === "verify") {
      if (currentTask && parsed.taskId === currentTask.id) {
        const result = await runCommand(parsed.command);
        console.log(result.output);
        
        // Check if verification passed (simple check for now)
        const verificationPassed = result.success &&
          !result.output.toLowerCase().includes("error") &&
          !result.output.toLowerCase().includes("not found");
        
        if (verificationPassed) {
          // Mark criterion as verified
          if (currentTask.successCriteria && currentTask.successCriteria[parsed.criterionIndex]) {
            currentTask.successCriteria[parsed.criterionIndex].verified = true;
            console.log(`✅ Criterion ${parsed.criterionIndex} verified: ${currentTask.successCriteria[parsed.criterionIndex].criterion}`);
          }
          
          // Check if all criteria are now verified
          if (verifyTaskCompletion(currentTask.id)) {
            updateTaskStatus(currentTask.id, 'completed', 'All success criteria verified');
            console.log(`🎯 Task fully verified: "${currentTask.description}"`);
            break;
          }
        } else {
          console.log(`❌ Verification failed for criterion ${parsed.criterionIndex}`);
          messages.push({
            role: "assistant",
            content: `Verification failed for criterion: ${parsed.criterionIndex}\nOutput: ${result.output}`
          });
        }
      }
      compressContext();
      updateSystemPrompt();
      continue;
    }

    if (parsed.action === "run") {
      if (!AUTO_APPROVE) {
        const confirm = await ask(`⚠ Run "${parsed.command}"? (y/n): `);
        if (confirm !== "y") {
          // User declined, break out of task continuation
          if (currentTask) {
            updateTaskStatus(currentTask.id, 'pending');
          }
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
        if (currentTask) {
          updateTaskStatus(currentTask.id, 'failed', `Command failed: ${parsed.command}`);
        }
      } else {
        messages.push({
          role: "assistant",
          content: `Command executed successfully:\n${result.output}`
        });
        // Task continues
      }
      compressContext();
      updateSystemPrompt();
      
      // Continue to next step (don't return)
      console.log("🔄 Continuing to next step...");
      continue;
    }

    if (parsed.action === "patch") {
      if (!AUTO_APPROVE) {
        const confirm = await ask(`⚠ Patch file "${parsed.file}"? (y/n): `);
        if (confirm !== "y") {
          if (currentTask) {
            updateTaskStatus(currentTask.id, 'pending');
          }
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
      updateSystemPrompt();
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
      updateSystemPrompt();
      continue;
    }
    
    // Unknown action, break
    break;
  }
  
  if (steps >= maxSteps) {
    console.log("⚠ Maximum task steps reached. Returning to interactive mode.");
    if (currentTask) {
      updateTaskStatus(currentTask.id, 'pending');
    }
  }
  
  // Update system prompt one last time
  updateSystemPrompt();
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
