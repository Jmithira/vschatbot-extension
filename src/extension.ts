import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('cse-code-buddy.openChat', () => {
        ChatPanel.createOrShow(context.extensionUri);
    });
    context.subscriptions.push(disposable);
}

class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    public static readonly viewType = 'cseChatView';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _apiKey: string = '';
    private _chatHistory: { role: string, content: string }[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ChatPanel.viewType,
            'CSE Code Buddy',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );
        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveKey':
                        this._apiKey = message.key.trim();
                        vscode.window.showInformationMessage('Groq API Key updated successfully.');
                        return;
                    case 'sendMessage':
                        if (!this._apiKey) {
                            this._panel.webview.postMessage({ command: 'error', text: 'Please enter a valid Groq API Key first.' });
                            return;
                        }
                        await this._runAgentEngine(message.text);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _getWorkspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    // Agent Engine Loop
    private async _runAgentEngine(userMessage: string) {
        // Reset chat history tracking for a clean task run loop
        this._chatHistory = [];
        
        const systemPrompt = `You are an elite Software Engineering Agent. Your task is to analyze user requests and interact with local workspace files using automated thoughts.

CRITICAL FORMATTING RULE:
You must ALWAYS respond in a strict JSON format. Do not include any text outside the JSON object. Do not use markdown blocks (\`\`\`json) in your overall response. Just return the raw JSON object.

JSON Response Schema Options:

1. If you need to read a file to check for errors, return:
{
    "action": "read",
    "path": "relative/path/to/file.ext",
    "thought": "Brief reason why you are reading the file"
}

2. If you have found an error and want to surgically update a block of code, return:
{
    "action": "update",
    "path": "relative/path/to/file.ext",
    "targetCode": "EXACT target code string currently in the file that has the error",
    "replacementCode": "The new corrected code string to swap in",
    "thought": "Explanation of the logical bug you are fixing"
}

3. If you are finished with the task or just answering a general question, return:
{
    "action": "final",
    "message": "Your complete final analysis or explanation in markdown format."
}`;

        this._chatHistory.push({ role: 'system', content: systemPrompt });
        this._chatHistory.push({ role: 'user', content: userMessage });

        let keepRunning = true;
        let loopCount = 0;
        const maxLoops = 5; // Guardrail to prevent infinite API loops

        while (keepRunning && loopCount < maxLoops) {
            loopCount++;
            try {
                this._panel.webview.postMessage({ command: 'status', text: 'ai thinking...' });

                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this._apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        messages: this._chatHistory,
                        temperature: 0.1,
                        response_format: { type: "json_object" } // Enforces strict JSON output from Groq
                    })
                });

                const data: any = await response.json();
                if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);

                const rawJsonText = data.choices[0].message.content.trim();
                const agentDecision = JSON.parse(rawJsonText);

                // 1. Handle READ action
                if (agentDecision.action === 'read') {
                    this._panel.webview.postMessage({ command: 'status', text: `ai reading ${agentDecision.path}...` });
                    
                    const root = this._getWorkspaceRoot();
                    if (!root) {
                        this._panel.webview.postMessage({ command: 'error', text: 'Error: No workspace folder open.' });
                        return;
                    }
                    
                    const fullPath = path.join(root, agentDecision.path);
                    let fileContent = "";
                    if (fs.existsSync(fullPath)) {
                        fileContent = fs.readFileSync(fullPath, 'utf8');
                    } else {
                        fileContent = "Error: File not found.";
                    }

                    // Feed file content back to the AI context memory loop
                    this._chatHistory.push({ role: 'assistant', content: rawJsonText });
                    this._chatHistory.push({ 
                        role: 'user', 
                        content: `File Content of ${agentDecision.path}:\n\n${fileContent}\n\nAnalyze this content for bugs and decide your next action.` 
                    });
                } 
                
                // 2. Handle UPDATE action (Surgical, robust search-and-replace)
                else if (agentDecision.action === 'update') {
                    this._panel.webview.postMessage({ command: 'status', text: `ai updating ${agentDecision.path}...` });
                    
                    const root = this._getWorkspaceRoot();
                    if (!root) {
                        this._panel.webview.postMessage({ command: 'error', text: 'Error: No workspace folder open.' });
                        return;
                    }

                    const fullPath = path.join(root, agentDecision.path);
                    if (!fs.existsSync(fullPath)) {
                        this._panel.webview.postMessage({ command: 'error', text: `Error: File not found at ${agentDecision.path}` });
                        return;
                    }

                    // Read original content
                    let fileContent = fs.readFileSync(fullPath, 'utf8');

                    // Helper function to normalize line endings and trim whitespace around lines
                    const normalizeText = (text: string) => {
                        return text
                            .replace(/\r\n/g, '\n') // Convert Windows CRLF to standard LF
                            .split('\n')
                            .map(line => line.trimEnd()) // Remove trailing spaces from each line
                            .join('\n')
                            .trim();
                    };

                    const normalizedFileContent = normalizeText(fileContent);
                    const normalizedTarget = normalizeText(agentDecision.targetCode);
                    const normalizedReplacement = agentDecision.replacementCode.replace(/\r\n/g, '\n');

                    // Strategy 1: Attempt exact match check on normalized structures
                    if (normalizedFileContent.includes(normalizedTarget)) {
                        // To accurately preserve the user's specific indentation style, 
                        // we split the file and search for the block sequence
                        const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
                        const targetLines = agentDecision.targetCode.replace(/\r\n/g, '\n').split('\n').map((l: string) => l.trim());                        
                        let matchIndex = -1;
                        
                        // Scan file lines to find where the trimmed versions match sequentially
                        for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
                            let matches = true;
                            for (let j = 0; j < targetLines.length; j++) {
                                if (fileLines[i + j].trim() !== targetLines[j]) {
                                    matches = false;
                                    break;
                                }
                            }
                            if (matches) {
                                matchIndex = i;
                                break;
                            }
                        }

                        if (matchIndex !== -1) {
                            // Detect the base indentation of the original code block
                            const originalFirstLine = fileLines[matchIndex];
                            const indentationMatch = originalFirstLine.match(/^([ \t]*)/);
                            const baseIndentation = indentationMatch ? indentationMatch[1] : '';

                            // Apply that exact indentation style to the incoming replacement rows
                            const indentedReplacement = normalizedReplacement
                                .split('\n')
                                .map((line: string, idx: number) => idx === 0 ? line : baseIndentation + line)
                                .join('\n');

                            // Splice the old block out and insert the new one
                            fileLines.splice(matchIndex, targetLines.length, indentedReplacement);
                            fs.writeFileSync(fullPath, fileLines.join('\n'), 'utf8');
                        } else {
                            // Fallback direct string replacement if line parsing behaves unexpectedly
                            fileContent = fileContent.replace(agentDecision.targetCode, agentDecision.replacementCode);
                            fs.writeFileSync(fullPath, fileContent, 'utf8');
                        }
                    } else {
                        // Strategy 2: Absolute Fallback if AI missed exact match context strings completely
                        // We ask the AI to try again with a cleaner block structure context
                        this._chatHistory.push({ role: 'assistant', content: rawJsonText });
                        this._chatHistory.push({ 
                            role: 'user', 
                            content: `Error: The code block you provided in "targetCode" does not exactly match anything in the file. Please view the file again and provide an exact snippet match.` 
                        });
                        continue;
                    }

                    // Notify AI that file modification was an absolute success
                    this._chatHistory.push({ role: 'assistant', content: rawJsonText });
                    this._chatHistory.push({ 
                        role: 'user', 
                        content: `Success: The file ${agentDecision.path} has been updated in the workspace. Now produce your final explanation summary using action 'final'.` 
                    });
                }
                
                // 3. Handle FINAL conclusion action
                else if (agentDecision.action === 'final') {
                    this._panel.webview.postMessage({ command: 'aiResponse', text: agentDecision.message });
                    keepRunning = false;
                } else {
                    keepRunning = false;
                }

            } catch (err: any) {
                this._panel.webview.postMessage({ command: 'error', text: `Agent Error: ${err.message}` });
                keepRunning = false;
            }
        }
    }

    private _update() {
        this._panel.webview.html = this._htmlTemplate();
    }

    private _htmlTemplate(): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-autoloader.min.js"></script>
            <style>
                body { font-family: -apple-system, sans-serif; padding: 15px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); margin: 0; }
                .config-container { display: flex; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
                .config-container input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 10px; border-radius: 4px; font-size: 12px; }
                .config-container button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                #chat-area { flex: 1; overflow-y: auto; padding-right: 4px; margin-bottom: 15px; display: flex; flex-direction: column; gap: 12px; }
                .message-wrapper { display: flex; flex-direction: column; max-width: 85%; padding: 12px 16px; border-radius: 8px; font-size: 13px; line-height: 1.5; position: relative; }
                .user-msg { align-self: flex-end; background-color: #FCE4EC; color: #263238; border-bottom-right-radius: 1px; }
                .ai-msg { align-self: flex-start; background-color: #E3F2FD; color: #263238; border-bottom-left-radius: 1px; }
                #status-tracker { font-size: 11px; font-style: italic; color: var(--vscode-descriptionForeground); padding: 4px; margin-bottom: 4px; text-transform: lowercase; }
                .input-container { display: flex; gap: 8px; padding: 10px 0; }
                #user-input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px; border-radius: 4px; height: 36px; resize: none; }
                #send-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 0 16px; border-radius: 4px; cursor: pointer; }
                .error-msg { align-self: center; background-color: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); font-size: 12px; border-radius: 4px; padding: 6px 12px; }
                
                .code-block-container { position: relative; margin: 8px 0; }
                pre { background: #1e1e1e !important; padding: 32px 12px 12px 12px !important; border-radius: 6px; overflow-x: auto; margin: 0; }
                .copy-btn { position: absolute; top: 6px; right: 8px; background: rgba(255,255,255,0.15); color: #ffffff; border: none; padding: 3px 8px; font-size: 10px; border-radius: 3px; cursor: pointer; text-transform: uppercase; }
                .copy-btn:hover { background: rgba(255,255,255,0.3); }
            </style>
        </head>
        <body>
            <div class="config-container">
                <input type="password" id="api-key-input" placeholder="Enter Groq API Key here..." />
                <button id="save-key-btn">Save Key</button>
            </div>
            <div id="status-tracker"></div>
            <div id="chat-area"></div>
            <div class="input-container">
                <textarea id="user-input" placeholder="Ask a question or specify file modifications..."></textarea>
                <button id="send-btn">Send</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const chatArea = document.getElementById('chat-area');
                const userInput = document.getElementById('user-input');
                const sendBtn = document.getElementById('send-btn');
                const apiKeyInput = document.getElementById('api-key-input');
                const saveKeyBtn = document.getElementById('save-key-btn');
                const statusTracker = document.getElementById('status-tracker');

                marked.setOptions({ gfm: true, breaks: true });

                saveKeyBtn.addEventListener('click', () => {
                    if(apiKeyInput.value) vscode.postMessage({ command: 'saveKey', key: apiKeyInput.value });
                });

                sendBtn.addEventListener('click', sendMessage);
                userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

                function sendMessage() {
                    const text = userInput.value.trim();
                    if (!text) return;
                    const userDiv = document.createElement('div');
                    userDiv.className = 'message-wrapper user-msg';
                    userDiv.textContent = text;
                    chatArea.appendChild(userDiv);
                    vscode.postMessage({ command: 'sendMessage', text: text });
                    userInput.value = '';
                    chatArea.scrollTop = chatArea.scrollHeight;
                }

                function copyToClipboard(text, btn) {
                    navigator.clipboard.writeText(text).then(() => {
                        const originalText = btn.textContent;
                        btn.textContent = 'COPIED';
                        setTimeout(() => { btn.textContent = originalText; }, 1500);
                    });
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'status':
                            statusTracker.textContent = message.text;
                            break;
                        case 'aiResponse':
                            statusTracker.textContent = '';
                            const aiDiv = document.createElement('div');
                            aiDiv.className = 'message-wrapper ai-msg';
                            aiDiv.innerHTML = marked.parse(message.text);
                            
                            aiDiv.querySelectorAll('pre').forEach((preElement) => {
                                const container = document.createElement('div');
                                container.className = 'code-block-container';
                                const codeText = preElement.querySelector('code')?.textContent || preElement.textContent;
                                
                                const copyBtn = document.createElement('button');
                                copyBtn.className = 'copy-btn';
                                copyBtn.textContent = 'COPY';
                                copyBtn.addEventListener('click', () => copyToClipboard(codeText, copyBtn));
                                
                                preElement.parentNode.insertBefore(container, preElement);
                                container.appendChild(preElement);
                                container.appendChild(copyBtn);
                            });

                            chatArea.appendChild(aiDiv);
                            Prism.highlightAllUnder(aiDiv);
                            break;
                        case 'error':
                            statusTracker.textContent = '';
                            const errDiv = document.createElement('div');
                            errDiv.className = 'error-msg';
                            errDiv.textContent = message.text;
                            chatArea.appendChild(errDiv);
                            break;
                    }
                    chatArea.scrollTop = chatArea.scrollHeight;
                });
            </script>
        </body>
        </html>`;
    }

    public dispose() {
        ChatPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}