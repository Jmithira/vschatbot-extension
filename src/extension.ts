// Previous Chat Preserved
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('cse-code-buddy.openChat', () => {
        ChatPanel.createOrShow(context.extensionUri);
    });
    context.subscriptions.push(disposable);
}

interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
}

class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    public static readonly viewType = 'cseChatView';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _apiKey: string = '';
    private _agentContextHistory: { role: string, content: string }[] = [];

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
                    case 'initialized':
                        this._loadAndDisplayHistory();
                        return;
                    case 'saveKey':
                        this._apiKey = message.key.trim();
                        vscode.window.showInformationMessage('Groq API Key updated successfully.');
                        return;
                    case 'sendMessage':
                        if (!this._apiKey) {
                            this._panel.webview.postMessage({ command: 'error', text: 'Please enter a valid Groq API Key first.' });
                            return;
                        }
                        // Save user message locally first
                        this._saveMessageToDisk('user', message.text, message.timestamp);
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

    private _getHistoryFilePath(): string | undefined {
        const root = this._getWorkspaceRoot();
        if (!root) return undefined;
        return path.join(root, '.code_buddy_history.json');
    }

    // Read full historical transcript from local workspace JSON database
    private _getSavedHistory(): ChatMessage[] {
        const filePath = this._getHistoryFilePath();
        if (!filePath || !fs.existsSync(filePath)) return [];
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data) as ChatMessage[];
        } catch {
            return [];
        }
    }

    // Save message logs right to disk
    private _saveMessageToDisk(role: 'user' | 'assistant', text: string, timestamp: string) {
        const filePath = this._getHistoryFilePath();
        if (!filePath) return;
        const history = this._getSavedHistory();
        history.push({ role, text, timestamp });
        try {
            fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
        } catch (err) {
            console.error("Failed to write chat log history file", err);
        }
    }

    // Sends saved history arrays back to UI panel at bootup
    private _loadAndDisplayHistory() {
        const history = this._getSavedHistory();
        if (history.length > 0) {
            this._panel.webview.postMessage({ command: 'loadHistory', history: history });
        }
    }

    // Agent Engine Loop
    private async _runAgentEngine(userMessage: string) {
        const lowerMessage = userMessage.toLowerCase();
        const restrictedKeywords = [
            'medicine', 'prescription', 'doctor', 'medical', 'headache', 'migraine', 
            'pill', 'tablet', 'symptom', 'disease', 'diagnosis', 'therapy', 'drug'
        ];
        
        const containsRestricted = restrictedKeywords.some(keyword => lowerMessage.includes(keyword));
        if (containsRestricted) {
            const blockedResponse = "I am optimized exclusively for computer science, software engineering, and programming inquiries. I cannot provide assistance on this topic.";
            const fallbackTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            this._panel.webview.postMessage({ command: 'aiResponse', text: blockedResponse, timestamp: fallbackTime });
            this._saveMessageToDisk('assistant', blockedResponse, fallbackTime);
            return;
        }

        // Token Guardrail: Pull only the LAST 10 conversations from disk to protect Groq TPM bounds
        const fullHistory = this._getSavedHistory();
        const optimizedRecentHistory = fullHistory.slice(-10);

        this._agentContextHistory = [];
        
        const systemPrompt = `You are an elite Software Engineering Agent. Your task is to analyze user requests and interact with local workspace files using automated thoughts. 
CRITICAL FOCUS & SCOPE RULE:
You are optimized exclusively for computer science, software engineering, IT, and programming inquiries. If a user asks a question outside of this technical scope, you MUST decline to answer. In such cases, ignore tool options and return a final response stating: "I am optimized exclusively for computer science, software engineering, and programming inquiries. I cannot provide assistance on out-of-scope topics."
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
    "replacementCode": "The new corrected code string to swap in. Indent it cleanly using relative spaces matching the structure.",
    "thought": "Explanation of the logical bug you are fixing"
}

3. If you are finished with the task or just answering a general question, return:
{
    "action": "final",
    "message": "Your complete final analysis or explanation in markdown format."
}`;

        this._agentContextHistory.push({ role: 'system', content: systemPrompt });
        
        // Feed the model the optimized sliding conversational parameters context
        optimizedRecentHistory.forEach(msg => {
            this._agentContextHistory.push({ 
                role: msg.role === 'user' ? 'user' : 'assistant', 
                content: msg.text 
            });
        });

        let keepRunning = true;
        let loopCount = 0;
        const maxLoops = 5;

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
                        messages: this._agentContextHistory,
                        temperature: 0.1,
                        response_format: { type: "json_object" }
                    })
                });

                const data: any = await response.json();
                if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);

                const rawJsonText = data.choices[0].message.content.trim();
                const agentDecision = JSON.parse(rawJsonText);

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

                    this._agentContextHistory.push({ role: 'assistant', content: rawJsonText });
                    this._agentContextHistory.push({ 
                        role: 'user', 
                        content: `File Content of ${agentDecision.path}:\n\n${fileContent}\n\nAnalyze this content for bugs and decide your next action.` 
                    });
                } 
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

                    let fileContent = fs.readFileSync(fullPath, 'utf8');
                    const normalizeText = (text: string) => text.replace(/\r\n/g, '\n');

                    const normalizedFileContent = normalizeText(fileContent);
                    const normalizedTarget = normalizeText(agentDecision.targetCode);
                    const normalizedReplacement = normalizeText(agentDecision.replacementCode);

                    if (normalizedFileContent.includes(normalizedTarget)) {
                        const targetIndex = normalizedFileContent.indexOf(normalizedTarget);
                        const lineStartIndex = normalizedFileContent.lastIndexOf('\n', targetIndex) + 1;
                        const matchingLinePrefix = normalizedFileContent.substring(lineStartIndex, targetIndex);
                        const indentationMatch = matchingLinePrefix.match(/^([ \t]*)/);
                        const baseIndentation = indentationMatch ? indentationMatch[1] : '';

                        const indentedReplacement = normalizedReplacement
                            .split('\n')
                            .map((line: string, idx: number) => {
                                if (line.trim() === '') return '';
                                if (idx === 0) return line; 
                                return baseIndentation + line;
                            })
                            .join('\n');

                        const updatedContent = normalizedFileContent.replace(normalizedTarget, indentedReplacement);
                        fs.writeFileSync(fullPath, updatedContent, 'utf8');
                    } else {
                        if (fileContent.includes(agentDecision.targetCode)) {
                            fileContent = fileContent.replace(agentDecision.targetCode, agentDecision.replacementCode);
                            fs.writeFileSync(fullPath, fileContent, 'utf8');
                        } else {
                            this._agentContextHistory.push({ role: 'assistant', content: rawJsonText });
                            this._agentContextHistory.push({ 
                                role: 'user', 
                                content: `Error: The code block you provided in "targetCode" does not exactly match anything in the file. Please view the file again and provide an exact snippet match.` 
                            });
                            continue;
                        }
                    }

                    this._agentContextHistory.push({ role: 'assistant', content: rawJsonText });
                    this._agentContextHistory.push({ 
                        role: 'user', 
                        content: `Success: The file ${agentDecision.path} has been updated in the workspace. Now produce your final explanation summary using action 'final'.` 
                    });
                } 
                else if (agentDecision.action === 'final') {
                    const aiTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    
                    // Display response in Panel UI
                    this._panel.webview.postMessage({ command: 'aiResponse', text: agentDecision.message, timestamp: aiTime });
                    
                    // Commit final AI turn response log into local database
                    this._saveMessageToDisk('assistant', agentDecision.message, aiTime);
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
                
                .chat-header { padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
                .chat-header h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--vscode-settings-headerForeground, var(--vscode-editor-foreground)); letter-spacing: 0.3px; }
                
                .config-container { display: flex; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
                .config-container input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 10px; border-radius: 4px; font-size: 12px; }
                .config-container button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
                #chat-area { flex: 1; overflow-y: auto; padding-right: 4px; margin-bottom: 15px; display: flex; flex-direction: column; gap: 14px; }
                
                .message-wrapper { display: flex; flex-direction: column; max-width: 85%; padding: 12px 16px; border-radius: 8px; font-size: 13px; line-height: 1.5; position: relative; }
                .user-msg { align-self: flex-end; background-color: #FCE4EC; color: #2D2426; border-bottom-right-radius: 1px; }
                .ai-msg { align-self: flex-start; background-color: #E3F2FD; color: #1A2E40; border-bottom-left-radius: 1px; }
                
                .user-msg > span, .ai-msg > div { color: inherit; }

                .msg-timestamp { font-size: 10px; opacity: 0.65; margin-top: 6px; font-weight: normal; align-self: flex-end; user-select: none; }
                .user-msg .msg-timestamp { color: #5D4037 !important; }
                .ai-msg .msg-timestamp { color: #546E7A !important; }

                #status-tracker { font-size: 11px; font-style: italic; color: var(--vscode-descriptionForeground); padding: 4px; margin-bottom: 4px; text-transform: lowercase; }
                .input-container { display: flex; gap: 8px; padding: 10px 0; }
                #user-input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px; border-radius: 4px; height: 36px; resize: none; }
                #send-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 0 16px; border-radius: 4px; cursor: pointer; }
                .error-msg { align-self: center; background-color: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); font-size: 12px; border-radius: 4px; padding: 6px 12px; }
                
                .code-block-container { position: relative; margin: 8px 0; }
                pre[class*="language-"], pre { background: #1e1e1e !important; padding: 32px 12px 12px 12px !important; border-radius: 6px; overflow-x: auto; margin: 0; border: 1px solid #333; }
                code[class*="language-"], pre code { font-family: 'Courier New', monospace; font-size: 13px; text-shadow: none !important; }
                
                .message-wrapper pre code, .message-wrapper pre span, .message-wrapper .token { text-shadow: none !important; }
                .message-wrapper .token.comment { color: #6a9955 !important; }
                .message-wrapper .token.punctuation { color: #d4d4d4 !important; }
                .message-wrapper .token.property, .message-wrapper .token.tag, .message-wrapper .token.number { color: #b5cea8 !important; }
                .message-wrapper .token.selector, .message-wrapper .token.attr-name, .message-wrapper .token.string { color: #ce9178 !important; }
                .message-wrapper .token.operator, .message-wrapper .token.keyword { color: #569cd6 !important; }
                .message-wrapper .token.function, .message-wrapper .token.class-name { color: #dcdcaa !important; }
                
                .message-wrapper pre * { color: #f4f4f4; }
                .copy-btn { position: absolute; top: 6px; right: 8px; background: rgba(255,255,255,0.15); color: #ffffff !important; border: none; padding: 3px 8px; font-size: 10px; border-radius: 3px; cursor: pointer; text-transform: uppercase; }
                .copy-btn:hover { background: rgba(255,255,255,0.3); }
            </style>
        </head>
        <body>
            <div class="chat-header">
                <h2>CSE Code Buddy — Chat Workspace</h2>
            </div>

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

                // Let the extension know the UI is fully ready to display archived history logs
                window.addEventListener('load', () => {
                    vscode.postMessage({ command: 'initialized' });
                });

                saveKeyBtn.addEventListener('click', () => {
                    if(apiKeyInput.value) vscode.postMessage({ command: 'saveKey', key: apiKeyInput.value });
                });

                sendBtn.addEventListener('click', sendMessage);
                userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

                function getFormattedTime() {
                    const now = new Date();
                    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                }

                function sendMessage() {
                    const text = userInput.value.trim();
                    if (!text) return;
                    
                    const currentTime = getFormattedTime();
                    appendMessageToUI('user', text, currentTime);
                    
                    vscode.postMessage({ command: 'sendMessage', text: text, timestamp: currentTime });
                    userInput.value = '';
                }

                function appendMessageToUI(role, text, timestamp) {
                    const msgDiv = document.createElement('div');
                    if (role === 'user') {
                        msgDiv.className = 'message-wrapper user-msg';
                        const textSpan = document.createElement('span');
                        textSpan.textContent = text;
                        msgDiv.appendChild(textSpan);
                    } else {
                        msgDiv.className = 'message-wrapper ai-msg';
                        const contentDiv = document.createElement('div');
                        contentDiv.innerHTML = marked.parse(text);
                        msgDiv.appendChild(contentDiv);
                        
                        contentDiv.querySelectorAll('pre').forEach((preElement) => {
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
                    }
                    
                    const timeDiv = document.createElement('div');
                    timeDiv.className = 'msg-timestamp';
                    timeDiv.textContent = timestamp;
                    msgDiv.appendChild(timeDiv);

                    chatArea.appendChild(msgDiv);
                    if (role === 'assistant') {
                        Prism.highlightAllUnder(msgDiv);
                    }
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
                        case 'loadHistory':
                            chatArea.innerHTML = ''; // clear initial screen
                            message.history.forEach(msg => {
                                appendMessageToUI(msg.role, msg.text, msg.timestamp);
                            });
                            break;
                        case 'status':
                            statusTracker.textContent = message.text;
                            break;
                        case 'aiResponse':
                            statusTracker.textContent = '';
                            appendMessageToUI('assistant', message.text, message.timestamp);
                            break;
                        case 'error':
                            statusTracker.textContent = '';
                            const errDiv = document.createElement('div');
                            errDiv.className = 'error-msg';
                            errDiv.textContent = message.text;
                            chatArea.appendChild(errDiv);
                            chatArea.scrollTop = chatArea.scrollHeight;
                            break;
                    }
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