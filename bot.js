const { Telegraf } = require("telegraf");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const readline = require('readline');

// Bot token management
let BOT_TOKEN = process.env.BOT_TOKEN;
const REPO_URL = "https://github.com/adamfarreledu-cloud/java.git";
const REPO_DIR = "./java";

// Initialize bot (will be set after token is confirmed)
let bot;

// User session storage with persistent file backup
const userSessions = new Map();
const SESSION_FILE = path.join(__dirname, 'user_sessions.json');

// Load sessions from file on startup
function loadSessions() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = fs.readFileSync(SESSION_FILE, 'utf8');
            const sessions = JSON.parse(data);

            // Convert plain objects back to Map
            Object.entries(sessions).forEach(([userId, sessionData]) => {
                userSessions.set(userId, sessionData);
            });

            console.log(`📂 Loaded ${Object.keys(sessions).length} user sessions from file`);
        }
    } catch (error) {
        console.log('⚠️ Could not load sessions from file:', error.message);
    }
}

// Save sessions to file
function saveSessions() {
    try {
        // Convert Map to plain object for JSON storage
        const sessionsObj = {};
        userSessions.forEach((session, userId) => {
            // Only save essential login credentials, not temporary process data
            sessionsObj[userId] = {
                apiId: session.apiId,
                apiHash: session.apiHash,
                phone: session.phone,
                state: session.state === 'processing' ? 'idle' : session.state, // Reset processing state
                // Don't save process, progressMessageId, or other temporary data
            };
        });

        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionsObj, null, 2));
        console.log(`💾 Saved ${Object.keys(sessionsObj).length} user sessions to file`);
    } catch (error) {
        console.log('⚠️ Could not save sessions to file:', error.message);
    }
}

// Auto-save sessions periodically
setInterval(saveSessions, 30000); // Save every 30 seconds

// Simple progress tracking
const progressTimers = new Map(); // userId -> intervalId
const PROGRESS_INTERVAL = 60000; // Send progress every 60 seconds (reduced frequency)
const errorCounts = new Map(); // Track error counts per user

// Enhanced progress tracking
const detailedProgress = new Map(); // userId -> detailed progress info
const batchProgress = new Map(); // userId -> current batch progress
const fileSizes = new Map(); // userId -> file size tracking
const sessionStats = new Map(); // userId -> session statistics

// Batch processing tracking
const BATCH_SIZE = 10; // Process 10 files per batch
const completedBatches = new Map(); // userId -> completed batch count
const currentBatchFiles = new Map(); // userId -> current batch files info

// Rate limiting for Telegram API calls
const messageQueue = new Map(); // userId -> array of pending messages
const rateLimitDelay = 2000; // 2 seconds between messages
const processingQueue = new Set(); // Track which users are being processed

// Message spam prevention
const sentMessages = new Map(); // userId -> Set of message hashes
const messageHashes = new Map(); // userId -> last 100 message hashes for cleanup

// Speed monitoring for downloads/uploads
const SpeedMonitor = require('./speed-monitor');
const speedMonitor = new SpeedMonitor();
const speedMonitorIntervals = new Map(); // userId -> intervalId for speed updates

// Bot states
const STATES = {
    IDLE: "idle",
    AWAITING_CONSENT: "awaiting_consent",
    AWAITING_API_ID: "awaiting_api_id",
    AWAITING_API_HASH: "awaiting_api_hash",
    AWAITING_PHONE: "awaiting_phone",
    AWAITING_OTP: "awaiting_otp",
    AWAITING_CHANNEL: "awaiting_channel",
    AWAITING_OPTION: "awaiting_option",
    AWAITING_DESTINATION: "awaiting_destination",
    PROCESSING: "processing",
    AWAITING_CONTINUATION: "awaiting_continuation",
    AWAITING_CONFIG_FILE: "awaiting_config_file",
};

// Progress tracking for web dashboard
let globalProgress = {
    status: "idle",
    task: "Waiting for user commands",
    completed: 0,
    total: 100,
    activeUsers: 0,
    lastUpdate: new Date().toISOString(),
};

// Clone repository on startup
async function cloneRepository() {
    return new Promise((resolve, reject) => {
        // Remove existing directory if it exists
        if (fs.existsSync(REPO_DIR)) {
            exec(`rm -rf ${REPO_DIR}`, (error) => {
                if (error) {
                    console.error("Error removing existing directory:", error);
                    // Don't fail on cleanup error, try to continue
                    console.warn("Continuing despite cleanup error...");
                }
                performClone();
            });
        } else {
            performClone();
        }

        function performClone() {
            // Add timeout and better error handling for cloud environments
            const cloneCommand = `timeout 60 git clone --depth 1 ${REPO_URL}`;
            exec(cloneCommand, { timeout: 65000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error("Error cloning repository:", error);
                    console.error("STDERR:", stderr);
                    // Try fallback without timeout for Render compatibility
                    exec(
                        `git clone --depth 1 ${REPO_URL}`,
                        (fallbackError, fallbackStdout) => {
                            if (fallbackError) {
                                console.error(
                                    "Fallback clone also failed:",
                                    fallbackError,
                                );
                                reject(fallbackError);
                                return;
                            }
                            console.log(
                                "Repository cloned successfully (fallback)",
                            );
                            console.log(fallbackStdout);
                            resolve();
                        },
                    );
                    return;
                }
                console.log("Repository cloned successfully");
                console.log(stdout);
                resolve();
            });
        }
    });
}

// Get or create user session
function getUserSession(userId) {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            state: STATES.IDLE,
            process: null,
            phone: null,
            channel: null,
            option: null,
            destination: null,
            apiId: null,
            apiHash: null,
            progressMessageId: null,
            filesDownloaded: 0,
            filesUploaded: 0,
            filesRemaining: 0,
            totalFiles: 0,
            currentBatch: 0,
            totalBatches: 0,
            sessionStartTime: null,
            downloadErrors: [],
            uploadErrors: [],
            isProcessing: false,
            currentChannel: null
        });

        // Auto-save when new session is created
        saveSessions();
    }
    return userSessions.get(userId);
}

// Update global progress (called when bot processes tasks)
function updateProgress(status, task, completed = 0, total = 100) {
    globalProgress = {
        status,
        task,
        completed,
        total,
        activeUsers: userSessions.size,
        lastUpdate: new Date().toISOString(),
    };
    console.log(
        `📊 Progress Update: ${status} - ${task} (${completed}/${total})`,
    );
}

// Generate message hash for deduplication
function generateMessageHash(message) {
    let hash = 0;
    for (let i = 0; i < message.length; i++) {
        const char = message.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
}

// Check if message is duplicate
function isDuplicateMessage(userId, message) {
    // Allow these specific messages to bypass duplicate blocking
    const allowedMessages = [
        '⏳ Processing... Downloads continuing in background..',
        '📊 Current Internet Speed:'
    ];

    // Check if message starts with any allowed message pattern
    if (allowedMessages.some(allowed => message.includes(allowed))) {
        return false; // Never block these messages
    }

    if (!sentMessages.has(userId)) {
        sentMessages.set(userId, new Set());
    }

    const messageHash = generateMessageHash(message);
    const userHashes = sentMessages.get(userId);

    if (userHashes.has(messageHash)) {
        return true; // Duplicate found
    }

    // Add to sent messages
    userHashes.add(messageHash);

    // Clean up old hashes (keep last 100)
    if (userHashes.size > 100) {
        const oldestHash = userHashes.values().next().value;
        userHashes.delete(oldestHash);
    }

    return false;
}

// Clear duplicate message history for a user
function clearUserDuplicates(userId) {
    if (sentMessages.has(userId)) {
        sentMessages.delete(userId);
        console.log(`🧹 Cleared duplicate message history for user ${userId}`);
    }
}


// Check if command is network intensive (download/upload)
function isNetworkIntensiveCommand(command) {
    const networkKeywords = [
        'download', 'upload', 'wget', 'curl', 'git clone',
        'npm install', 'pip install', 'apt install', 'yum install',
        'rsync', 'scp', 'ftp', 'sftp', 'aria2c'
    ];

    return networkKeywords.some(keyword =>
        command.toLowerCase().includes(keyword.toLowerCase())
    );
}

// Start speed monitoring for user
function startSpeedMonitoring(userId, ctx) {
    if (speedMonitorIntervals.has(userId)) {
        clearInterval(speedMonitorIntervals.get(userId));
    }

    speedMonitor.startMonitoring();
    sendRateLimitedMessage(ctx, '⏳ Download/Upload started...');

    // Send speed updates every 2 minutes
    const intervalId = setInterval(async () => {
        const speedInfo = await speedMonitor.getCurrentSpeed();
        const speedMessage = `📊 Current Internet Speed:
- Download: ${speedInfo.download} MB/s
- Upload: ${speedInfo.upload} MB/s
- Total: ${speedInfo.total} MB/s
(Updates every 2 min)`;

        sendRateLimitedMessage(ctx, speedMessage);
    }, 120000); // 2 minutes

    speedMonitorIntervals.set(userId, intervalId);
}

// Stop speed monitoring for user
function stopSpeedMonitoring(userId) {
    if (speedMonitorIntervals.has(userId)) {
        clearInterval(speedMonitorIntervals.get(userId));
        speedMonitorIntervals.delete(userId);
        speedMonitor.stopMonitoring();
    }
}

// Start simple progress timer
function startProgressTimer(ctx, userId) {
    // Clear any existing timer
    if (progressTimers.has(userId)) {
        clearInterval(progressTimers.get(userId));
    }

    // Initialize error counter for this user
    if (!errorCounts.has(userId)) {
        errorCounts.set(userId, { total: 0, fileExpired: 0, timeout: 0 });
    }

    // Send progress message every 60 seconds with summary
    const timerId = setInterval(() => {
        try {
            const errors = errorCounts.get(userId) || {
                total: 0,
                fileExpired: 0,
                timeout: 0,
            };
            let statusMessage =
                "⏳ Processing... Downloads continuing in background.";

            if (errors.total > 0) {
                statusMessage += `\n📊 Status: ${errors.total} auto-retries (${errors.fileExpired} file refs, ${errors.timeout} timeouts)`;
            }

            sendRateLimitedMessage(ctx, statusMessage);
        } catch (error) {
            console.log("Error sending progress message:", error.message);
        }
    }, PROGRESS_INTERVAL);

    progressTimers.set(userId, timerId);
}

// Stop progress timer
function stopProgressTimer(userId) {
    if (progressTimers.has(userId)) {
        clearInterval(progressTimers.get(userId));
        progressTimers.delete(userId);
    }
}

// Enhanced CLI output parsing for accurate progress tracking
function trackFileProgress(userId, output) {
    const session = getUserSession(userId);
    let stats = sessionStats.get(userId) || {
        downloaded: 0,
        uploaded: 0,
        remaining: 0,
        total: 0,
        completedBatches: 0,
        currentBatch: 1,
        errors: [],
        downloadedFiles: [],
        uploadedFiles: [],
        incompleteFiles: []
    };

    // Parse total files from CLI output
    if (output.includes('Ultra-processing') && output.includes('messages')) {
        const totalMatch = output.match(/Ultra-processing\s+(\d+)\/\d+\s+messages/) ||
            output.match(/Ultra-processing\s+(\d+)\s+messages/);
        if (totalMatch) {
            const total = parseInt(totalMatch[1]);
            stats.total = total;
            stats.remaining = Math.max(0, total - stats.downloaded - stats.uploaded);
            session.totalFiles = total;
            console.log(`📊 Total files updated: ${total}`);
        }
    }

    // Track downloads with enhanced parsing for complete file names and message IDs
    if (output.includes('Downloaded:') || (output.includes('\u2705') && output.includes('Download complete'))) {
        // Enhanced regex to capture file names and optional [MsgID:XXX] tag
        const fileMatch = output.match(/(?:Downloaded:|Download complete)\s*(?:\d+\/\d+:\s*)?(.+?)(?:\s*\[MsgID:(\d+)\])?(?:\s*\((\d+(?:\.\d+)?)\s*Mbps\))?(?:\s*[\u2713\u2714].*)?$/);
        if (fileMatch) {
            stats.downloaded++;
            session.filesDownloaded = stats.downloaded;
            stats.remaining = Math.max(0, stats.total - stats.downloaded - stats.uploaded);

            let fileName = fileMatch[1].trim();

            // Extract actual filename from path if present
            if (fileName.includes('/')) {
                fileName = fileName.split('/').pop();
            }

            // Clean up any remaining unwanted characters
            fileName = fileName.replace(/^\[/, '').replace(/\]$/, '').trim();
            // Remove trailing [MsgID:xxx] if regex didn't catch it
            fileName = fileName.replace(/\s*\[MsgID:\d+\]\s*$/, '').trim();

            const messageId = fileMatch[2] ? parseInt(fileMatch[2]) : null;
            const speedMbps = fileMatch[3] ? parseFloat(fileMatch[3]) : 0;

            stats.downloadedFiles.push({
                name: fileName,
                messageId: messageId,
                timestamp: new Date().toLocaleTimeString(),
                speed: speedMbps
            });

            // Track file size info
            let fileSizeInfo = fileSizes.get(userId) || {};
            fileSizeInfo[fileName] = {
                actualSize: 0,
                expectedSize: 0,
                downloaded: true,
                fullSize: true,
                messageId: messageId,
                timestamp: new Date().toLocaleTimeString()
            };
            fileSizes.set(userId, fileSizeInfo);

            console.log(`\ud83d\udce5 Download tracked: ${fileName}${messageId ? ' (Msg #' + messageId + ')' : ''} (Total: ${stats.downloaded})`);
        }
    }

    // Alternative parsing for file completion messages
    if (output.includes('✅') && output.includes('File written successfully:')) {
        const filePathMatch = output.match(/File written successfully:\s*(.+)$/);
        if (filePathMatch) {
            let fullPath = filePathMatch[1].trim();
            let fileName = fullPath.includes('/') ? fullPath.split('/').pop() : fullPath;

            // Only track if not already tracked
            let fileSizeInfo = fileSizes.get(userId) || {};
            if (!fileSizeInfo[fileName]) {
                stats.downloaded++;
                session.filesDownloaded = stats.downloaded;
                stats.remaining = Math.max(0, stats.total - stats.downloaded - stats.uploaded);

                fileSizeInfo[fileName] = {
                    actualSize: 0,
                    expectedSize: 0,
                    downloaded: true,
                    fullSize: true,
                    timestamp: new Date().toLocaleTimeString()
                };
                fileSizes.set(userId, fileSizeInfo);

                console.log(`📥 File completion tracked: ${fileName} (Total: ${stats.downloaded})`);
            }
        }
    }

    // Track uploads with enhanced parsing including message IDs
    if (output.includes('\ud83d\udce4') && (output.includes('Uploaded:') || output.includes('Upload complete'))) {
        const fileMatch = output.match(/\ud83d\udce4\s*Uploaded:\s*(?:Message\s*)?(.+?)(?:\s*\[MsgID:(\d+)\])?(?:\s*\((\d+(?:\.\d+)?)\s*Mbps\))?(?:\s*\[SINGLE-FILE.*\])?\s*$/);
        if (fileMatch) {
            stats.uploaded++;
            session.filesUploaded = stats.uploaded;
            stats.remaining = Math.max(0, stats.total - stats.downloaded - stats.uploaded);

            const fileName = fileMatch[1].trim();
            const messageId = fileMatch[2] ? parseInt(fileMatch[2]) : null;
            const speedMbps = fileMatch[3] ? parseFloat(fileMatch[3]) : 0;

            stats.uploadedFiles.push({
                name: fileName,
                messageId: messageId,
                timestamp: new Date().toLocaleTimeString(),
                speed: speedMbps
            });

            console.log(`\ud83d\udce4 Upload tracked: ${fileName}${messageId ? ' (Msg #' + messageId + ')' : ''} (Total: ${stats.uploaded})`);
        }
    }

    // Track failed downloads from CLI output (FAILED DOWNLOADS REPORT)
    if (output.includes('SKIPPING after') || output.includes('FAILED DOWNLOADS REPORT')) {
        const failMatch = output.match(/SKIPPING.*?:\s*(.+)$/);
        if (failMatch) {
            stats.failedDownloads = stats.failedDownloads || [];
            stats.failedDownloads.push({
                name: failMatch[1].trim(),
                timestamp: new Date().toLocaleTimeString()
            });
        }
        // Also try to parse structured fail report lines
        const structuredFail = output.match(/Message\s+(\d+).*?:\s*(.+)$/);
        if (structuredFail) {
            stats.failedDownloads = stats.failedDownloads || [];
            stats.failedDownloads.push({
                messageId: parseInt(structuredFail[1]),
                name: structuredFail[2].trim(),
                timestamp: new Date().toLocaleTimeString()
            });
        }
    }

    // Track batch completion
    if (output.includes('Ultra-speed batch') && output.includes('complete')) {
        const batchMatch = output.match(/Ultra-speed batch\s+(\d+)\/(\d+)\s+complete/);
        if (batchMatch) {
            stats.completedBatches = parseInt(batchMatch[1]);
            stats.totalBatches = parseInt(batchMatch[2]);
            stats.currentBatch = Math.min(stats.completedBatches + 1, stats.totalBatches);

            // Track per-batch file boundaries for current batch info
            stats.batchFileStartIndex = stats.batchFileStartIndex || 0;
            stats.batchDownloadStart = stats.downloadedFiles ? stats.downloadedFiles.length : 0;
            stats.batchUploadStart = stats.uploadedFiles ? stats.uploadedFiles.length : 0;
            stats.batchFailStart = stats.failedDownloads ? stats.failedDownloads.length : 0;

            console.log(`🔢 Batch progress: ${stats.completedBatches}/${stats.totalBatches} complete, current: ${stats.currentBatch}`);
        }
    }

    // Track size verification issues
    if (output.includes('Size mismatch') || output.includes('Incomplete download') || output.includes('does not download in full size')) {
        const fileMatch = output.match(/(?:Size mismatch|Incomplete download|does not download in full size).*?([^\s]+\.[a-zA-Z0-9]+)/);
        if (fileMatch) {
            const fileName = fileMatch[1];
            let fileSizeInfo = fileSizes.get(userId) || {};
            if (fileSizeInfo[fileName]) {
                fileSizeInfo[fileName].fullSize = false;
            } else {
                fileSizeInfo[fileName] = {
                    actualSize: 0,
                    expectedSize: 0,
                    downloaded: true,
                    fullSize: false,
                    timestamp: new Date().toLocaleTimeString()
                };
            }
            fileSizes.set(userId, fileSizeInfo);

            stats.incompleteFiles.push({
                name: fileName,
                timestamp: new Date().toLocaleTimeString(),
                reason: 'Size verification failed'
            });
        }
    }

    // Track errors with enhanced parsing
    if (output.includes('❌') && (output.includes('Error') || output.includes('Failed'))) {
        const errorMatch = output.match(/❌\s*(.+)/);
        if (errorMatch) {
            const errorMsg = errorMatch[1].trim();
            stats.errors = stats.errors || [];
            stats.errors.push(`${new Date().toLocaleTimeString()}: ${errorMsg}`);

            // Keep only last 10 errors
            if (stats.errors.length > 10) {
                stats.errors = stats.errors.slice(-10);
            }
        }
    }

    sessionStats.set(userId, stats);
}

// Generate batch report as .txt file and send as document
function sendBatchCompletionReport(userId, ctx, batchNumber) {
    const stats = sessionStats.get(userId) || {};
    const session = getUserSession(userId);
    const totalBatches = stats.totalBatches || '?';

    // Determine per-batch file boundaries
    const prevDownEnd = stats.prevBatchDownloadEnd || 0;
    const prevUpEnd = stats.prevBatchUploadEnd || 0;
    const prevFailEnd = stats.prevBatchFailEnd || 0;

    const allDownloaded = stats.downloadedFiles || [];
    const allUploaded = stats.uploadedFiles || [];
    const allFailed = stats.failedDownloads || [];

    // Current batch = files added since last batch report
    const currentBatchDownloads = allDownloaded.slice(prevDownEnd);
    const currentBatchUploads = allUploaded.slice(prevUpEnd);

    // Update boundaries for next batch
    stats.prevBatchDownloadEnd = allDownloaded.length;
    stats.prevBatchUploadEnd = allUploaded.length;
    stats.prevBatchFailEnd = allFailed.length;
    sessionStats.set(userId, stats);

    // Build txt file content
    let txt = '';
    txt += `batch ${batchNumber}/${totalBatches}\n\n\n`;

    // Config section
    if (session.uploadedConfig) {
        const cfg = session.uploadedConfig;
        txt += `API_ID=${cfg.API_ID}\n`;
        txt += `API_HASH=${cfg.API_HASH}\n`;
        txt += `SESSION_ID=${cfg.SESSION_ID || 'not_set'}\n`;
        txt += `DOWNLOAD_CHANNEL=${cfg.DOWNLOAD_CHANNEL}\n`;
        txt += `DOWNLOAD_MODE=${cfg.DOWNLOAD_MODE}\n`;
        if (cfg.SPECIFIC_MESSAGES) {
            txt += `SPECIFIC_MESSAGES=${cfg.SPECIFIC_MESSAGES}\n`;
        }
        if (cfg.UPLOAD_CHANNEL) {
            txt += `UPLOAD_CHANNEL=${cfg.UPLOAD_CHANNEL}\n`;
        }
    } else {
        txt += `DOWNLOAD_CHANNEL=${session.currentChannel || 'unknown'}\n`;
    }

    txt += `\n\n\n`;

    // Current batch info
    txt += `_____current batch info______\n`;
    let idx = 1;
    if (currentBatchDownloads.length > 0 || currentBatchUploads.length > 0) {
        currentBatchDownloads.forEach(file => {
            const msgId = file.messageId ? file.messageId : '';
            txt += `${idx}.[${file.name}] ${msgId}\n`;
            idx++;
        });
        currentBatchUploads.forEach(file => {
            const msgId = file.messageId ? file.messageId : '';
            txt += `${idx}.[${file.name}] ${msgId}\n`;
            idx++;
        });
    } else {
        txt += `(no files in this batch)\n`;
    }

    txt += `\n`;

    // Cumulative success (overall across all batches)
    txt += `______success message download and upload(overall batch)______\n`;
    idx = 1;
    if (allDownloaded.length > 0 || allUploaded.length > 0) {
        allDownloaded.forEach(file => {
            const msgId = file.messageId ? file.messageId : '';
            const batchTag = idx > prevDownEnd ? '(added from batch ' + batchNumber + ')' : '';
            txt += `${idx}.[${file.name}] ${msgId}${batchTag}\n`;
            idx++;
        });
        allUploaded.forEach(file => {
            const msgId = file.messageId ? file.messageId : '';
            const upIdx = idx;
            const batchTag = (upIdx - allDownloaded.length) > prevUpEnd ? '(added from batch ' + batchNumber + ')' : '';
            txt += `${idx}.[${file.name}] ${msgId}${batchTag}\n`;
            idx++;
        });
    } else {
        txt += `(no successful files yet)\n`;
    }

    txt += `\n`;

    // Cumulative failed (overall across all batches)
    txt += `FAILED download and upload(overall batch)\n`;
    if (allFailed.length > 0) {
        idx = 1;
        allFailed.forEach((fail, i) => {
            const msgId = fail.messageId ? fail.messageId : '';
            const batchTag = i >= prevFailEnd ? '(added from batch ' + batchNumber + ')' : '';
            txt += `${idx}.[${fail.name}] ${msgId}${batchTag}\n`;
            idx++;
        });
    } else {
        txt += `(no failures)\n`;
    }

    txt += `\n`;

    // Send as .txt file document
    try {
        const fileName = `batch_${batchNumber}_of_${totalBatches}_report.txt`;
        const fileBuffer = Buffer.from(txt, 'utf8');
        ctx.replyWithDocument(
            { source: fileBuffer, filename: fileName },
            { caption: `\ud83c\udfaf Batch ${batchNumber}/${totalBatches} Report` }
        ).catch(err => {
            console.error('Failed to send batch report file:', err.message);
            // Fallback: send as message
            sendRateLimitedMessage(ctx, `\ud83c\udfaf **Batch ${batchNumber}/${totalBatches} Report**\n\n${txt.substring(0, 3000)}`);
        });
    } catch (error) {
        console.error('Error creating batch report:', error.message);
        sendRateLimitedMessage(ctx, `\ud83c\udfaf Batch ${batchNumber}/${totalBatches} complete. Downloaded: ${stats.downloaded || 0}, Failed: ${allFailed.length}`);
    }
}

// Generate final completion report as .txt file
function sendFinalCompletionReport(userId, ctx) {
    const stats = sessionStats.get(userId) || {};
    const session = getUserSession(userId);
    const totalBatches = stats.totalBatches || stats.completedBatches || '?';

    const allDownloaded = stats.downloadedFiles || [];
    const allUploaded = stats.uploadedFiles || [];
    const allFailed = stats.failedDownloads || [];

    let txt = '';
    txt += `FINAL REPORT - All ${totalBatches} batches completed\n\n`;
    txt += `Total Downloaded: ${stats.downloaded || 0} files\n`;
    txt += `Total Uploaded: ${stats.uploaded || 0} files\n`;
    txt += `Total Batches: ${stats.completedBatches || 0}\n`;
    txt += `Total Files Processed: ${stats.total || 0}\n\n\n`;

    // Config section
    if (session.uploadedConfig) {
        const cfg = session.uploadedConfig;
        txt += `API_ID=${cfg.API_ID}\n`;
        txt += `API_HASH=${cfg.API_HASH}\n`;
        txt += `SESSION_ID=${cfg.SESSION_ID || 'not_set'}\n`;
        txt += `DOWNLOAD_CHANNEL=${cfg.DOWNLOAD_CHANNEL}\n`;
        txt += `DOWNLOAD_MODE=${cfg.DOWNLOAD_MODE}\n`;
        if (cfg.SPECIFIC_MESSAGES) {
            txt += `SPECIFIC_MESSAGES=${cfg.SPECIFIC_MESSAGES}\n`;
        }
        if (cfg.UPLOAD_CHANNEL) {
            txt += `UPLOAD_CHANNEL=${cfg.UPLOAD_CHANNEL}\n`;
        }
    } else {
        txt += `DOWNLOAD_CHANNEL=${session.currentChannel || 'unknown'}\n`;
    }

    txt += `\n\n\n`;

    // All success files
    txt += `______success message download and upload(overall)______\n`;
    let idx = 1;
    if (allDownloaded.length > 0 || allUploaded.length > 0) {
        allDownloaded.forEach(file => {
            const msgId = file.messageId ? file.messageId : '';
            txt += `${idx}.[${file.name}] ${msgId}\n`;
            idx++;
        });
        allUploaded.forEach(file => {
            const msgId = file.messageId ? file.messageId : '';
            txt += `${idx}.[${file.name}] ${msgId}\n`;
            idx++;
        });
    } else {
        txt += `(no successful files)\n`;
    }

    txt += `\n`;

    // All failed files
    txt += `FAILED download and upload(overall)\n`;
    if (allFailed.length > 0) {
        idx = 1;
        allFailed.forEach(fail => {
            const msgId = fail.messageId ? fail.messageId : '';
            txt += `${idx}.[${fail.name}] ${msgId}\n`;
            idx++;
        });
    } else {
        txt += `(no failures)\n`;
    }

    txt += `\n`;

    // Send as .txt file document
    try {
        const fileName = `final_report_${totalBatches}_batches.txt`;
        const fileBuffer = Buffer.from(txt, 'utf8');
        ctx.replyWithDocument(
            { source: fileBuffer, filename: fileName },
            { caption: `\ud83c\udf89 Final Report - All ${totalBatches} batches completed!` }
        ).catch(err => {
            console.error('Failed to send final report file:', err.message);
            sendRateLimitedMessage(ctx, `\ud83c\udf89 **Final Report**\n\n${txt.substring(0, 3000)}`);
        });
    } catch (error) {
        console.error('Error creating final report:', error.message);
        sendRateLimitedMessage(ctx, `\ud83c\udf89 All done! Downloaded: ${stats.downloaded || 0}, Uploaded: ${stats.uploaded || 0}, Failed: ${allFailed.length}`);
    }
}

// Update current batch files info - Task 5 helper
function updateCurrentBatchFiles(userId, files) {
    currentBatchFiles.set(userId, files);
}

// Process completion and ask for continuation - Task 3
function handleProcessCompletion(userId, ctx) {
    const session = getUserSession(userId);
    session.state = STATES.AWAITING_CONTINUATION;

    const completionMessage = `🎉 **Channel processing completed!**\n\n` +
        `📊 Final Statistics:\n` +
        `✅ Downloaded: ${session.filesDownloaded} files\n` +
        `⬆️ Uploaded: ${session.filesUploaded} files\n\n` +
        `🔄 **What would you like to do next?**\n` +
        `• Type "ANOTHER" to process another channel\n` +
        `• Type "LOGOUT" to logout and end session\n` +
        `• Use /stop to stop and keep login for later\n` +
        `• Use /do to start a new task with existing login`;

    sendRateLimitedMessage(ctx, completionMessage);
}

// Rate-limited message sending with retry logic
async function sendRateLimitedMessage(ctx, message, retries = 3) {
    const userId = ctx.from.id;

    // Check for duplicate messages to prevent spam
    if (isDuplicateMessage(userId, message)) {
        console.log(`⚠️ Blocked duplicate message for user ${userId}: ${message.substring(0, 50)}...`);
        return Promise.resolve(false); // Skip duplicate
    }

    // Add message to queue
    if (!messageQueue.has(userId)) {
        messageQueue.set(userId, []);
    }

    return new Promise((resolve, reject) => {
        messageQueue
            .get(userId)
            .push({ message, retries, resolve, reject, ctx });
        processMessageQueue(userId);
    });
}

// Process message queue with rate limiting
async function processMessageQueue(userId) {
    if (processingQueue.has(userId)) return; // Already processing

    processingQueue.add(userId);
    const queue = messageQueue.get(userId) || [];

    while (queue.length > 0) {
        const { message, retries, resolve, reject, ctx } = queue.shift();

        try {
            await ctx.reply(message);
            resolve(true);

            // Rate limit: wait 1 second between messages
            if (queue.length > 0) {
                await new Promise((resolve) =>
                    setTimeout(resolve, rateLimitDelay),
                );
            }
        } catch (error) {
            // Handle system error -122 specifically
            if ((error.errno === -122 || error.message.includes('system error -122')) && retries > 0) {
                console.log(`⚠️ Warning: Write operation failed with system error -122.`);
                console.log(`Retrying in 5 seconds... (${retries} attempts left)`);

                await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 second delay for -122 errors

                queue.unshift({
                    message,
                    retries: retries - 1,
                    resolve,
                    reject,
                    ctx,
                });
                continue;
            } else if (error.message.includes("429") && retries > 0) {
                // Handle rate limit with exponential backoff
                const waitTime = error.response?.parameters?.retry_after || 15;
                console.log(
                    `⏳ Rate limited (429), waiting ${waitTime} seconds before retry...`,
                );

                // Increase wait time to prevent further rate limiting
                const actualWaitTime = Math.max(waitTime * 1000, 15000); // At least 15 seconds
                await new Promise((resolve) =>
                    setTimeout(resolve, actualWaitTime),
                );

                // Re-queue with reduced retries
                queue.unshift({
                    message,
                    retries: retries - 1,
                    resolve,
                    reject,
                    ctx,
                });
                continue;
            } else if (retries > 0 && !error.message.includes("403")) {
                // Retry other errors (except blocked/forbidden)
                console.log(
                    `⚠️ Message send failed, retrying... (${retries} attempts left)`,
                );
                await new Promise((resolve) => setTimeout(resolve, 2000));
                queue.unshift({
                    message,
                    retries: retries - 1,
                    resolve,
                    reject,
                    ctx,
                });
                continue;
            } else {
                // Handle persistent -122 errors after all retries
                if (error.errno === -122 || error.message.includes('system error -122')) {
                    console.error(`❌ Error: Persistent write failure (system error -122).`);
                    console.log(`Action: Skipped this write. Bot is still running.`);
                } else {
                    // Log error but don't crash
                    console.error(
                        `❌ Failed to send message after all retries: ${error.message}`,
                    );
                }
                resolve(false); // Resolve as failed instead of rejecting
            }
        }
    }

    processingQueue.delete(userId);
}

// Kill user process if exists (async for proper cleanup)
async function killUserProcess(userId) {
    const session = getUserSession(userId);

    // Kill the child process if it exists
    if (session.process && !session.process.killed) {
        session.process.kill("SIGTERM");
        session.process = null;
        // Wait a moment for process to terminate
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Clear all progress timers and monitoring
    stopProgressTimer(userId);
    stopSpeedMonitoring(userId);

    // Clear all tracking data
    sessionStats.delete(userId);
    completedBatches.delete(userId);
    currentBatchFiles.delete(userId);
    fileSizes.delete(userId);
    errorCounts.delete(userId);
    detailedProgress.delete(userId);
    batchProgress.delete(userId);

    // Clear message queue for this user
    if (messageQueue.has(userId)) {
        messageQueue.delete(userId);
    }

    // Remove from processing queue
    processingQueue.delete(userId);

    // Clear duplicate message history
    clearUserDuplicates(userId);

    console.log(`🧹 Complete cleanup done for user ${userId}`);
}

// Import auth functions for session handling
const { setBotContext } = require('./java/modules/auth');

// Helper functions for process management
function handleProcessOutput(ctx, userId, output) {
    const session = getUserSession(userId);

    // Clean ANSI escape codes and control characters
    output = output
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI escape sequences
        .replace(/\x1b\[[0-9]*[ABCD]/g, "") // Remove cursor movement
        .replace(/\x1b\[[0-9]*[JK]/g, "") // Remove clear sequences
        .replace(/\x1b\[[0-9]*[G]/g, "") // Remove cursor positioning
        .replace(/\r/g, "") // Remove carriage returns
        .replace(/\n+/g, "\n") // Normalize newlines
        .trim();

    if (output) {
        // Filter out progress spam and verbose logs
        if (output.includes("%") && output.includes("Mbps")) {
            // Skip individual progress messages - timer handles this
        } else if (
            output.includes("[INFO]") ||
            output.includes("Processing message") ||
            output.includes("Starting direct file download") ||
            output.includes("Connection to") ||
            output.includes("File lives in another DC")
        ) {
            // Skip verbose debug messages
        } else if (output.includes("FILE_REFERENCE_EXPIRED")) {
            // Handle file reference expired errors silently - script auto-retries
            console.log(
                `📋 File reference expired for a message, script will retry automatically`,
            );

            // Track error count for summary
            if (!errorCounts.has(userId)) {
                errorCounts.set(userId, {
                    total: 0,
                    fileExpired: 0,
                    timeout: 0,
                });
            }
            const errors = errorCounts.get(userId);
            errors.total++;
            errors.fileExpired++;
            // Don't send these to user - they're handled automatically
        } else if (output.includes("Timeout") && output.includes("503")) {
            // Handle timeout errors silently - script auto-retries
            console.log(
                `⏱️ Network timeout occurred, script will retry automatically`,
            );

            // Track timeout count
            if (!errorCounts.has(userId)) {
                errorCounts.set(userId, {
                    total: 0,
                    fileExpired: 0,
                    timeout: 0,
                });
            }
            const errors = errorCounts.get(userId);
            errors.total++;
            errors.timeout++;
            // Don't spam user with timeout messages
        } else if (
            output.includes("Download attempt") &&
            output.includes("failed")
        ) {
            // Handle individual download attempt failures silently
            console.log(
                `🔄 Download attempt failed, script will retry automatically`,
            );
            // Only log, don't send to user to avoid spam
        } else if (output.includes("BATCH") && output.includes("RETRY REPORT")) {
            // Send batch-level retry reports
            sendRateLimitedMessage(ctx, `📊 ${output}`);
        } else if (output.includes("BATCH") && output.includes("FAILED DOWNLOADS")) {
            // Send batch-level failed download reports
            sendRateLimitedMessage(ctx, `⚠️ ${output}`);
        } else if (
            output.includes("❌") &&
            (output.includes("Max retries reached") ||
                output.includes("permanently failed"))
        ) {
            // Only send final failures after all retries exhausted
            sendRateLimitedMessage(ctx, `🚨 ${output}`);
        } else if (
            output.includes("❌") ||
            output.includes("Error") ||
            output.includes("Failed") ||
            output.includes("Exception")
        ) {
            // Filter out common auto-retry errors, only send critical ones
            const criticalErrors = [
                "CHAT_FORWARDS_RESTRICTED",
                "AUTH_KEY_INVALID",
                "USER_DEACTIVATED_BAN",
                "PHONE_NUMBER_INVALID",
                "SESSION_EXPIRED",
            ];

            const isCritical = criticalErrors.some((errorType) =>
                output.includes(errorType),
            );
            if (isCritical) {
                sendRateLimitedMessage(ctx, `🚨 ${output}`);
            } else {
                // Log but don't spam user with auto-retry errors
                console.log(
                    `⚠️ Non-critical error (auto-handled): ${output}`,
                );
            }
        } else if (
            output.includes("✅") ||
            output.includes("Downloaded") ||
            output.includes("complete")
        ) {
            // Track progress and file operations
            trackFileProgress(userId, output);

            // Check for batch completion and send detailed report
            if (output.includes("Ultra-speed batch") && output.includes("complete")) {
                const batchMatch = output.match(/Ultra-speed batch\s+(\d+)\/(\d+)\s+complete/);
                if (batchMatch) {
                    const batchNumber = parseInt(batchMatch[1]);
                    const totalBatches = parseInt(batchMatch[2]);

                    // Send batch completion report with file verification
                    setTimeout(() => sendBatchCompletionReport(userId, ctx, batchNumber), 1000);
                }
            }

            // Check for final process completion
            if (output.includes("Ultra-speed processing complete") ||
                output.includes("All messages processed") ||
                output.includes("No more messages")) {
                setTimeout(() => {
                    sendFinalCompletionReport(userId, ctx);
                    handleProcessCompletion(userId, ctx);
                }, 2000);
            }

            // Send success messages with rate limiting
            sendRateLimitedMessage(ctx, `✅ ${output}`);
        } else {
            // Send other important messages with rate limiting
            sendRateLimitedMessage(ctx, `📝 ${output}`);
        }

        // Parse output to determine next state
        if (output.includes("Enter your phone number")) {
            session.state = STATES.AWAITING_PHONE;
            session.isProcessing = false; // Stop processing until phone number is provided
            updateProgress(
                "authenticating",
                "Waiting for phone number",
                20,
                100,
            );
        } else if (
            output.includes("Enter OTP") ||
            output.includes("Enter the code")
        ) {
            session.state = STATES.AWAITING_OTP;
            session.isProcessing = false;
            updateProgress(
                "authenticating",
                "Waiting for OTP verification",
                40,
                100,
            );
        } else if (
            output.includes("Login successful") ||
            output.includes("logged in")
        ) {
            sendRateLimitedMessage(
                ctx,
                "✅ Login successful! Now enter the channel/chat ID:",
            );
            session.state = STATES.AWAITING_CHANNEL;
            session.isProcessing = false;
            updateProgress(
                "authenticated",
                "Selecting channel/chat",
                60,
                100,
            );
        } else if (
            output.includes("Choose:") ||
            output.includes("Select option")
        ) {
            session.state = STATES.AWAITING_OPTION;
            session.isProcessing = false;
            updateProgress(
                "configuring",
                "Selecting operation mode",
                70,
                100,
            );
        } else if (
            output.includes("destination") &&
            output.includes("channel")
        ) {
            session.state = STATES.AWAITING_DESTINATION;
            session.isProcessing = false;
            updateProgress(
                "configuring",
                "Setting destination channel",
                80,
                100,
            );
        } else if (output.includes("Search channel by name")) {
            sendRateLimitedMessage(
                ctx,
                "💡 The script is asking about channel search. Please respond with your choice.",
            );
        } else if (
            output.includes("Please enter name of channel to search")
        ) {
            sendRateLimitedMessage(
                ctx,
                "🔍 Enter the channel name you want to search for:",
            );
            session.state = STATES.AWAITING_CHANNEL;
            session.isProcessing = false;
            updateProgress("searching", "Searching for channel", 65, 100);
        } else if (
            output.includes("Downloading") ||
            output.includes("Uploading") ||
            output.includes("Progress")
        ) {
            session.state = STATES.PROCESSING;
            session.isProcessing = true;
            session.currentChannel = session.channel; // Store current channel for status

            // Extract progress from output if available
            const progressMatch = output.match(/(\d+)%/);
            const progressValue = progressMatch
                ? parseInt(progressMatch[1])
                : 85;

            if (output.includes("Downloading")) {
                updateProgress(
                    "downloading",
                    `Downloading: ${output.substring(0, 50)}...`,
                    progressValue,
                    100,
                );
            } else if (output.includes("Uploading")) {
                updateProgress(
                    "uploading",
                    `Uploading: ${output.substring(0, 50)}...`,
                    progressValue,
                    100,
                );
            } else {
                updateProgress(
                    "processing",
                    "Processing media files",
                    progressValue,
                    100,
                );
            }

            // Start progress timer when processing begins
            startProgressTimer(ctx, userId);

            // Initialize session tracking
            if (!sessionStats.has(userId)) {
                sessionStats.set(userId, {
                    downloaded: 0,
                    uploaded: 0,
                    remaining: 0,
                    total: 0,
                    completedBatches: 0,
                    currentBatch: 1,
                    errors: []
                });
            }
        } else if (
            output.includes("Done") ||
            output.includes("Completed") ||
            output.includes("Finished")
        ) {
            session.state = STATES.IDLE;
            session.isProcessing = false;

            // Send completion summary with error stats
            const errors = errorCounts.get(userId) || {
                total: 0,
                fileExpired: 0,
                timeout: 0,
            };
            let completionMessage =
                "🎉 Process completed! Use /start to begin a new session.";

            if (errors.total > 0) {
                completionMessage += `\n📊 Final Summary: ${errors.total} errors were auto-handled (${errors.fileExpired} file references, ${errors.timeout} timeouts)`;
            }

            sendRateLimitedMessage(ctx, completionMessage);
            updateProgress(
                "completed",
                "All tasks completed successfully",
                100,
                100,
            );

            // Clear error counts and stop progress timer
            errorCounts.delete(userId);
            stopProgressTimer(userId);
            stopSpeedMonitoring(userId);

            // Reset duplicate message history after successful completion
            clearUserDuplicates(userId);

            // Reset to idle after 30 seconds
            setTimeout(() => {
                if (userSessions.size === 0) {
                    updateProgress(
                        "idle",
                        "Waiting for user commands",
                        0,
                        100,
                    );
                }
            }, 30000);
        }
    }
}

function handleProcessClose(ctx, userId, code) {
    const session = getUserSession(userId);
    session.state = STATES.IDLE;
    session.process = null;
    session.isProcessing = false;

    // Stop speed monitoring when process ends
    stopSpeedMonitoring(userId);
    stopProgressTimer(userId);

    if (code === 0) {
        sendRateLimitedMessage(ctx, "✅ Process completed successfully! Use /start to begin again.");
    } else {
        sendRateLimitedMessage(ctx, `❌ Process exited with code ${code}. Use /start to try again.`);
    }
}

function handleProcessError(ctx, userId, error) {
    const session = getUserSession(userId);
    session.state = STATES.IDLE;
    session.process = null;
    session.isProcessing = false;

    // Stop speed monitoring on error
    stopSpeedMonitoring(userId);
    stopProgressTimer(userId);

    sendRateLimitedMessage(ctx, `❌ Process error: ${error.message}`);
}


// Setup bot event handlers
function setupBotHandlers() {
    // Start command
    bot.command("start", (ctx) => {
        const session = getUserSession(ctx.from.id);
        killUserProcess(ctx.from.id);

        // Clear any previous duplicate history for fresh session
        clearUserDuplicates(ctx.from.id);

        session.state = STATES.AWAITING_CONSENT;
        updateProgress(
            "active", "User starting authentication process", 0, 100);

        ctx.reply(
            "🚨 *SECURITY WARNING* 🚨\n\n" +
            "This bot will:\n" +
            "• Log into your Telegram account using YOUR API credentials\n" +
            "• Access your messages and media\n" +
            "• Download/upload files using your account\n\n" +
            "⚠️ Only proceed if you trust this bot completely.\n\n" +
            "📋 You will need:\n" +
            "• Your Telegram API ID\n" +
            "• Your Telegram API Hash\n" +
            "(Get these from https://my.telegram.org/auth)\n\n" +
            "💡 **Quick Commands:**\n" +
            "• /stop - Stop current task but keep login\n" +
            "• /do - Start new task with existing login\n" +
            "• /reset - Clear all data and start fresh\n\n" +
            'Type "I CONSENT" to continue or /cancel to abort.',
            { parse_mode: "Markdown" },
        );
    });

    // Cancel command
    bot.command("cancel", async (ctx) => {
        const session = getUserSession(ctx.from.id);
        await killUserProcess(ctx.from.id);
        session.state = STATES.IDLE;
        ctx.reply("❌ Operation cancelled. Use /start to begin again.");
    });

    // Stop command - stops task but keeps login credentials
    bot.command("stop", async (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);

        // Kill the current process and cleanup (killUserProcess now handles everything)
        await killUserProcess(userId);

        // Clear task-specific data but keep login credentials
        session.process = null;
        session.channel = null;
        session.option = null;
        session.destination = null;
        session.filesDownloaded = 0;
        session.filesUploaded = 0;
        session.filesRemaining = 0;
        session.totalFiles = 0;
        session.currentBatch = 0;
        session.totalBatches = 0;
        session.isProcessing = false;
        session.currentChannel = null;

        // Set state to logged in but not processing
        // Only require apiId and apiHash (phone is optional for resumed sessions)
        if (session.apiId && session.apiHash) {
            session.state = STATES.AWAITING_CHANNEL;
            saveSessions(); // Save the updated state
            const phoneDisplay = session.phone ? `📱 Phone: ${session.phone}\n` : "";
            ctx.reply(
                "⏹️ **Task stopped successfully!**\n\n" +
                "✅ Login credentials preserved\n" +
                phoneDisplay + "\n" +
                "🚀 Use /do to start a new download/upload task\n" +
                "🔄 Use /reset to clear all data and start fresh"
            );
        } else {
            session.state = STATES.IDLE;
            saveSessions(); // Save the updated state
            ctx.reply(
                "⏹️ **Task stopped!**\n\n" +
                "❌ No login session found\n" +
                "Use /start to begin a new session"
            );
        }
    });

    // Do command - starts channel selection with existing login
    bot.command("do", async (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);

        // Check if user has login credentials (only apiId and apiHash required)
        if (!session.apiId || !session.apiHash) {
            ctx.reply(
                "❌ **No login session found!**\n\n" +
                "Please use /start to login first with your:\n" +
                "• API ID\n" +
                "• API Hash\n\n" +
                "Then you can use /do to start downloading/uploading."
            );
            return;
        }

        // Update config.json with user's credentials before checking session
        try {
            updateConfigFile(session.apiId, session.apiHash);

            const configPath = path.join(REPO_DIR, "config.json");
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

                // If config has a valid session, we're good
                // If not, the resume process will handle authentication
                if (config.sessionId && config.sessionId.length >= 10) {
                    console.log("✅ Found valid session in config.json");
                } else {
                    console.log("⚠️ No session in config.json, will use resume flow for authentication");
                }
            }
        } catch (error) {
            console.log("⚠️ Error updating config:", error.message);
        }

        // Clear any previous duplicate history for fresh session
        clearUserDuplicates(userId);

        // Reset task-specific data but keep login credentials
        session.channel = null;
        session.option = null;
        session.destination = null;
        session.filesDownloaded = 0;
        session.filesUploaded = 0;
        session.filesRemaining = 0;
        session.totalFiles = 0;
        session.currentBatch = 0;
        session.totalBatches = 0;
        session.isProcessing = false;
        session.currentChannel = null;

        // Clear progress tracking for new session
        sessionStats.delete(userId);
        completedBatches.delete(userId);
        currentBatchFiles.delete(userId);
        fileSizes.delete(userId);
        errorCounts.delete(userId);

        await ctx.reply(
            "🚀 **Starting new download/upload task...**\n\n" +
            "✅ Using existing login session\n" +
            "📱 Phone: " + (session.phone || "Not set") + "\n\n" +
            "⏳ Preparing channel selection..."
        );

        // Set state and start the process directly from channel selection
        session.state = STATES.PROCESSING;
        session.isProcessing = true;
        session.currentChannel = 'Channel Selection';

        // Start the CLI process with existing credentials and resume flag
        spawnCliProcessWithResume(userId, ctx);

        updateProgress(
            "active",
            "Starting new task with existing login",
            0,
            100
        );
    });

    // Reset command
    bot.command("reset", (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);
        // Clear duplicate history on reset
        clearUserDuplicates(userId);

        // Kill any running process
        killUserProcess(userId);

        // Clear all session data
        session.state = STATES.IDLE;
        session.process = null;
        session.phone = null;
        session.channel = null;
        session.option = null;
        session.destination = null;
        session.apiId = null;
        session.apiHash = null;
        session.progressMessageId = null;
        session.filesDownloaded = 0;
        session.filesUploaded = 0;
        session.isProcessing = false;
        session.currentChannel = null;

        // Clear sessionId from config.json
        try {
            const configPath = path.join(REPO_DIR, "config.json");
            if (fs.existsSync(configPath)) {
                const config = {
                    apiId: 0,
                    apiHash: "",
                    sessionId: ""
                };
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                console.log("✅ Cleared config.json sessionId");
            }
        } catch (error) {
            console.log("⚠️ Error clearing config.json:", error.message);
        }

        // Clear from persistent storage
        userSessions.delete(userId);
        saveSessions();

        ctx.reply('🔄 Session reset completely. All credentials and session ID cleared. Send /start to begin again.');
    });

    // Status command
    bot.command("status", (ctx) => {
        const session = getUserSession(ctx.from.id);
        ctx.reply(`Current state: ${session.state}`);
    });

    // Info command - Shows accurate real-time data from CLI
    bot.command("info", async (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);
        const stats = sessionStats.get(userId) || {
            downloaded: 0,
            uploaded: 0,
            remaining: 0,
            total: 0,
            completedBatches: 0,
            currentBatch: 0,
            errors: []
        };

        // Get accurate data from session stats (updated by CLI output parsing)
        const downloaded = stats.downloaded || 0;
        const uploaded = stats.uploaded || 0;
        const totalFiles = stats.total || 0;
        const remaining = Math.max(0, totalFiles - downloaded - uploaded);
        const completedBatches = stats.completedBatches || 0;
        const currentBatch = Math.max(1, stats.currentBatch || (completedBatches + 1));

        let infoMessage = `📊 **Progress Report**\n\n`;
        infoMessage += `✅ Downloaded: ${downloaded} files\n`;
        infoMessage += `⬆️ Uploaded: ${uploaded} files\n`;
        infoMessage += `⏳ Remaining: ${remaining} files\n`;
        infoMessage += `📦 Total Files: ${totalFiles}\n`;
        infoMessage += `🔢 Completed Batches: ${completedBatches}\n`;
        infoMessage += `🔄 Current Batch: ${currentBatch}\n\n`;

        // Enhanced file size verification with real CLI data
        const fileSizeInfo = fileSizes.get(userId) || {};
        const fileNames = Object.keys(fileSizeInfo);

        if (fileNames.length > 0) {
            const completeFiles = fileNames.filter(fileName => fileSizeInfo[fileName].fullSize);
            const incompleteFiles = fileNames.filter(fileName => !fileSizeInfo[fileName].fullSize);

            if (incompleteFiles.length === 0) {
                infoMessage += `📏 **Size Verification:** ✅ All files downloaded in full size\n`;
            } else {
                infoMessage += `📏 **Size Verification:** ❌ ${incompleteFiles.length} files incomplete\n`;
                incompleteFiles.forEach(fileName => {
                    const fileInfo = fileSizeInfo[fileName];
                    const sizeInfo = fileInfo.expectedSize > 0 ?
                        ` (Expected: ${(fileInfo.expectedSize / 1024 / 1024).toFixed(2)}MB, Got: ${(fileInfo.actualSize / 1024 / 1024).toFixed(2)}MB)` : '';
                    infoMessage += `❌ ${fileName} does not download in full size${sizeInfo}\n`;
                });
            }
        } else {
            infoMessage += `📏 **Size Verification:** No files tracked yet\n`;
        }

        // Enhanced error reporting with real CLI data
        if (stats.errors && stats.errors.length > 0) {
            infoMessage += `\n🚨 **Recent Errors:**\n`;
            stats.errors.slice(-5).forEach(error => {
                infoMessage += `❌ ${error}\n`;
            });
        }

        sendRateLimitedMessage(ctx, infoMessage);
    });

    // Speed command
    bot.command("speed", async (ctx) => {
        try {
            const speedInfo = await speedMonitor.getCurrentSpeed();
            const speedMessage = `🚀 **Current Speed Report**\n\n`;
            let message = speedMessage;
            message += `⬇️ Download: ${speedInfo.download} MB/s\n`;
            message += `⬆️ Upload: ${speedInfo.upload} MB/s\n`;
            message += `📊 Total: ${speedInfo.total} MB/s\n`;
            message += `📡 Network Status: ${speedInfo.status || 'Active'}`;

            sendRateLimitedMessage(ctx, message);
        } catch (error) {
            sendRateLimitedMessage(ctx, "❌ Unable to get current speed. Speed monitoring may not be active.");
        }
    });

    // Config command - upload text file to configure bot
    bot.command("config", (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);

        // Kill any running process
        killUserProcess(userId);
        clearUserDuplicates(userId);

        session.state = STATES.AWAITING_CONFIG_FILE;

        ctx.reply(
            "📁 **Upload Config File**\n\n" +
            "Upload a `.txt` file with your settings in this format:\n\n" +
            "```\n" +
            "API_ID=32105620\n" +
            "API_HASH=b9c978bd80022786...\n" +
            "SESSION_ID=your_session_string\n" +
            "DOWNLOAD_CHANNEL=https://t.me/c/3516584528/70\n" +
            "DOWNLOAD_MODE=1\n" +
            "SPECIFIC_MESSAGES=101,102,103\n" +
            "UPLOAD_CHANNEL=https://t.me/c/9876543210/1\n" +
            "```\n\n" +
            "📝 **DOWNLOAD_MODE options:**\n" +
            "  1) Download ALL messages (no SPECIFIC_MESSAGES needed)\n" +
            "  2) Download SPECIFIC messages (SPECIFIC_MESSAGES = list of IDs)\n" +
            "  3) Download FROM message TO END (SPECIFIC_MESSAGES = ONE starting ID)\n" +
            "  4) COMPARE and SYNC channels (no SPECIFIC_MESSAGES needed)\n\n" +
            "⚠️ Required: API_ID, API_HASH, DOWNLOAD_CHANNEL\n" +
            "📎 Upload your `.txt` file now or /cancel to abort.",
            { parse_mode: "Markdown" }
        );
    });

    // Document handler for text file config upload
    bot.on("document", async (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);

        // Only handle documents when awaiting config file
        if (session.state !== STATES.AWAITING_CONFIG_FILE) {
            // Forward document to process if in processing state
            if (session.state === STATES.PROCESSING && session.process && !session.process.killed) {
                return;
            }
            ctx.reply("📎 To upload a config file, first use the /config command.");
            return;
        }

        const doc = ctx.message.document;

        // Validate file type
        if (!doc.file_name || (!doc.file_name.endsWith('.txt') && !doc.file_name.endsWith('.cfg') && !doc.file_name.endsWith('.conf'))) {
            ctx.reply("❌ Please upload a `.txt` file with your settings.\nUse /config to see the format.");
            return;
        }

        // Validate file size (max 10KB - config files should be tiny)
        if (doc.file_size > 10240) {
            ctx.reply("❌ Config file is too large. It should be under 10KB.");
            return;
        }

        try {
            ctx.reply("⏳ Reading config file...");

            // Download the file
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const https = require('https');
            const http = require('http');
            const client = fileLink.href.startsWith('https') ? https : http;

            const fileContent = await new Promise((resolve, reject) => {
                let data = '';
                client.get(fileLink.href, (res) => {
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => resolve(data));
                    res.on('error', reject);
                }).on('error', reject);
            });

            // Parse key=value pairs
            const configLines = fileContent.split('\n');
            const config = {};

            for (const line of configLines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

                const eqIndex = trimmed.indexOf('=');
                if (eqIndex === -1) continue;

                const key = trimmed.substring(0, eqIndex).trim().toUpperCase();
                const value = trimmed.substring(eqIndex + 1).trim();

                if (key && value) {
                    config[key] = value;
                }
            }

            // Helper: parse channel ID from t.me link or plain ID
            function parseChannelFromLink(value) {
                if (!value) return value;
                // Match https://t.me/c/CHANNEL_ID/MESSAGE_ID or https://t.me/c/CHANNEL_ID
                const linkMatch = value.match(/t\.me\/c\/(\d+)(?:\/\d+)?/);
                if (linkMatch) {
                    return '-100' + linkMatch[1];
                }
                // Already a plain channel ID (e.g., -1001234567890)
                return value;
            }

            // Parse channel links into proper channel IDs
            if (config.DOWNLOAD_CHANNEL) {
                config.DOWNLOAD_CHANNEL = parseChannelFromLink(config.DOWNLOAD_CHANNEL);
            }
            if (config.UPLOAD_CHANNEL) {
                config.UPLOAD_CHANNEL = parseChannelFromLink(config.UPLOAD_CHANNEL);
            }

            // Validate required fields
            const errors = [];
            if (!config.API_ID || !/^\d+$/.test(config.API_ID)) {
                errors.push("API_ID is missing or not a number");
            }
            if (!config.API_HASH || config.API_HASH.length < 10) {
                errors.push("API_HASH is missing or too short");
            }
            if (!config.DOWNLOAD_CHANNEL) {
                errors.push("DOWNLOAD_CHANNEL is missing");
            }

            if (errors.length > 0) {
                ctx.reply(
                    "❌ **Config file has errors:**\n\n" +
                    errors.map(e => `• ${e}`).join('\n') + "\n\n" +
                    "Please fix and re-upload, or use /config to see the format.",
                    { parse_mode: "Markdown" }
                );
                return;
            }

            // Parse download mode (default to 1 = full)
            const downloadMode = parseInt(config.DOWNLOAD_MODE) || 1;
            if (downloadMode < 1 || downloadMode > 4) {
                ctx.reply("❌ DOWNLOAD_MODE must be 1-4. Use /config to see options.");
                return;
            }

            // Parse specific messages - only used for modes 2 and 3
            let specificMessages = [];
            if ((downloadMode === 2 || downloadMode === 3) && config.SPECIFIC_MESSAGES) {
                specificMessages = config.SPECIFIC_MESSAGES
                    .split(',')
                    .map(id => parseInt(id.trim()))
                    .filter(id => !isNaN(id) && id > 0);
            }

            // Validate mode-specific requirements
            if (downloadMode === 2 && specificMessages.length === 0) {
                ctx.reply("❌ DOWNLOAD_MODE=2 (specific) requires SPECIFIC_MESSAGES field with message IDs.");
                return;
            }
            if (downloadMode === 3 && specificMessages.length === 0) {
                ctx.reply("❌ DOWNLOAD_MODE=3 (from-to-end) requires SPECIFIC_MESSAGES field with ONE starting message ID.");
                return;
            }
            if (downloadMode === 3 && specificMessages.length > 1) {
                // Mode 3 only uses the first ID as starting point
                ctx.reply(`⚠️ Mode 3 uses only ONE starting message ID. Using first ID: ${specificMessages[0]}`);
                specificMessages = [specificMessages[0]];
            }

            // Update user session
            session.apiId = config.API_ID;
            session.apiHash = config.API_HASH;
            saveSessions();

            // Update config.json with credentials and session
            const configPath = path.join(REPO_DIR, "config.json");
            const javaConfig = {
                apiId: parseInt(config.API_ID),
                apiHash: config.API_HASH,
                sessionId: config.SESSION_ID || "",
            };
            fs.writeFileSync(configPath, JSON.stringify(javaConfig, null, 2));

            // Build download mode name
            const modeNames = {
                1: "Download ALL messages (ULTRA-SPEED)",
                2: `Download SPECIFIC messages (${specificMessages.length} IDs)`,
                3: `Download FROM message ${specificMessages[0]} TO END`,
                4: "COMPARE and SYNC channels"
            };

            // Build confirmation message
            let confirmMsg = "✅ **Config loaded successfully!**\n\n";
            confirmMsg += `🔑 API ID: ${config.API_ID}\n`;
            confirmMsg += `🗝️ API Hash: ${config.API_HASH.substring(0, 6)}...${config.API_HASH.slice(-4)}\n`;
            confirmMsg += `🔐 Session: ${config.SESSION_ID ? '✅ Provided' : '❌ Not set (will need auth)'}\n`;
            confirmMsg += `📥 Download Channel: ${config.DOWNLOAD_CHANNEL}\n`;
            confirmMsg += `📝 Mode: ${modeNames[downloadMode]}\n`;
            if (specificMessages.length > 0 && downloadMode !== 1) {
                confirmMsg += `📋 Messages: ${specificMessages.join(', ')}\n`;
            }
            if (config.UPLOAD_CHANNEL) {
                confirmMsg += `📤 Upload Channel: ${config.UPLOAD_CHANNEL}\n`;
            } else {
                confirmMsg += `💾 Upload: Disabled (local storage only)\n`;
            }
            confirmMsg += `\n🚀 Starting download process...`;

            await ctx.reply(confirmMsg, { parse_mode: "Markdown" });

            // Clear progress tracking for new session
            sessionStats.delete(userId);
            completedBatches.delete(userId);
            currentBatchFiles.delete(userId);
            fileSizes.delete(userId);
            errorCounts.delete(userId);
            clearUserDuplicates(userId);

            // Set state to processing
            session.state = STATES.PROCESSING;
            session.isProcessing = true;
            session.currentChannel = config.DOWNLOAD_CHANNEL;

            // Store config in session for batch report txt files
            session.uploadedConfig = {
                API_ID: config.API_ID,
                API_HASH: config.API_HASH,
                SESSION_ID: config.SESSION_ID || '',
                DOWNLOAD_CHANNEL: config.DOWNLOAD_CHANNEL,
                DOWNLOAD_MODE: downloadMode.toString(),
                SPECIFIC_MESSAGES: specificMessages.length > 0 ? specificMessages.join(',') : '',
                UPLOAD_CHANNEL: config.UPLOAD_CHANNEL || '',
            };

            // Build the config JSON to pass to the CLI process
            const cliConfig = {
                channelId: config.DOWNLOAD_CHANNEL,
                downloadMode: downloadMode,
                specificMessages: specificMessages,
                uploadChannel: config.UPLOAD_CHANNEL || null,
            };

            // Spawn CLI process with config
            spawnCliProcessWithConfig(userId, ctx, cliConfig);

            updateProgress("active", "Processing config file upload", 0, 100);

        } catch (error) {
            console.error("Config file processing error:", error);
            ctx.reply(`❌ Error processing config file: ${error.message}\n\nPlease try again with /config`);
            session.state = STATES.IDLE;
        }
    });

    // Update config file with user credentials
    function updateConfigFile(apiId, apiHash, preserveSession = true) {
        const configPath = path.join(REPO_DIR, "config.json");

        let existingSessionId = "";
        if (preserveSession && fs.existsSync(configPath)) {
            try {
                const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                existingSessionId = existingConfig.sessionId || "";
            } catch (error) {
                console.log("⚠️ Could not read existing session:", error.message);
            }
        }

        const config = {
            apiId: parseInt(apiId),
            apiHash: apiHash,
            sessionId: existingSessionId,
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    // Spawn CLI process
    function spawnCliProcess(userId, ctx) {
        const session = getUserSession(userId);

        // Update config file with user's API credentials
        updateConfigFile(session.apiId, session.apiHash);

        // Start speed monitoring for network operations
        startSpeedMonitoring(userId, ctx);

        // Change to repository directory and run the script
        const process = spawn("node", ["index.js"], {
            cwd: REPO_DIR,
            stdio: ["pipe", "pipe", "pipe"],
        });

        session.process = process;

        // Handle stdout
        process.stdout.on("data", (data) => {
            let output = data.toString();

            // Clean ANSI escape codes and control characters
            output = output
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI escape sequences
                .replace(/\x1b\[[0-9]*[ABCD]/g, "") // Remove cursor movement
                .replace(/\x1b\[[0-9]*[JK]/g, "") // Remove clear sequences
                .replace(/\x1b\[[0-9]*[G]/g, "") // Remove cursor positioning
                .replace(/\r/g, "") // Remove carriage returns
                .replace(/\n+/g, "\n") // Normalize newlines
                .trim();

            if (output) {
                handleProcessOutput(ctx, userId, output);
            }
        });

        // Handle stderr
        process.stderr.on("data", (data) => {
            const error = data.toString().trim();
            if (error) {
                sendRateLimitedMessage(ctx, `❌ Error: ${error}`);
            }
        });

        // Handle process exit
        process.on("close", (code) => {
            handleProcessClose(ctx, userId, code);
        });

        // Handle process error
        process.on("error", (error) => {
            handleProcessError(ctx, userId, error);
        });
    }

    // Spawn CLI process with resume flag for /do command
    function spawnCliProcessWithResume(userId, ctx) {
        const session = getUserSession(userId);

        // Update config file with user's API credentials
        updateConfigFile(session.apiId, session.apiHash);

        // Start speed monitoring for network operations
        startSpeedMonitoring(userId, ctx);

        // Change to repository directory and run the script with resume flag
        const process = spawn("node", ["index.js", "--resume"], {
            cwd: REPO_DIR,
            stdio: ["pipe", "pipe", "pipe"],
        });

        session.process = process;

        // Handle stdout
        process.stdout.on("data", (data) => {
            let output = data.toString();

            // Clean ANSI escape codes and control characters
            output = output
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI escape sequences
                .replace(/\x1b\[[0-9]*[ABCD]/g, "") // Remove cursor movement
                .replace(/\x1b\[[0-9]*[JK]/g, "") // Remove clear sequences
                .replace(/\x1b\[[0-9]*[G]/g, "") // Remove cursor positioning
                .replace(/\r/g, "") // Remove carriage returns
                .replace(/\n+/g, "\n") // Normalize newlines
                .trim();

            if (output) {
                handleProcessOutput(ctx, userId, output);
            }
        });

        // Handle stderr
        process.stderr.on("data", (data) => {
            const error = data.toString().trim();
            if (error) {
                sendRateLimitedMessage(ctx, `❌ Error: ${error}`);
            }
        });

        // Handle process exit
        process.on("close", (code) => {
            handleProcessClose(ctx, userId, code);
        });

        // Handle process error
        process.on("error", (error) => {
            handleProcessError(ctx, userId, error);
        });
    }

    // Spawn CLI process with pre-loaded config from text file upload
    function spawnCliProcessWithConfig(userId, ctx, cliConfig) {
        const session = getUserSession(userId);

        // Update config file with user's API credentials
        updateConfigFile(session.apiId, session.apiHash);

        // Start speed monitoring for network operations
        startSpeedMonitoring(userId, ctx);

        // Encode config as base64 JSON to pass via CLI argument
        const configBase64 = Buffer.from(JSON.stringify(cliConfig)).toString('base64');

        // Change to repository directory and run the script with config
        const process = spawn("node", ["index.js", "--config-json", configBase64], {
            cwd: REPO_DIR,
            stdio: ["pipe", "pipe", "pipe"],
        });

        session.process = process;

        // Handle stdout
        process.stdout.on("data", (data) => {
            let output = data.toString();

            // Clean ANSI escape codes and control characters
            output = output
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI escape sequences
                .replace(/\x1b\[[0-9]*[ABCD]/g, "") // Remove cursor movement
                .replace(/\x1b\[[0-9]*[JK]/g, "") // Remove clear sequences
                .replace(/\x1b\[[0-9]*[G]/g, "") // Remove cursor positioning
                .replace(/\r/g, "") // Remove carriage returns
                .replace(/\n+/g, "\n") // Normalize newlines
                .trim();

            if (output) {
                handleProcessOutput(ctx, userId, output);
            }
        });

        // Handle stderr
        process.stderr.on("data", (data) => {
            const error = data.toString().trim();
            if (error) {
                sendRateLimitedMessage(ctx, `❌ Error: ${error}`);
            }
        });

        // Handle process exit
        process.on("close", (code) => {
            handleProcessClose(ctx, userId, code);
        });

        // Handle process error
        process.on("error", (error) => {
            handleProcessError(ctx, userId, error);
        });
    }

    // Send input to CLI process
    function sendToProcess(userId, input) {
        const session = getUserSession(userId);
        if (session.process && session.process.stdin && !session.process.killed) {
            session.process.stdin.write(input + "\n");
            return true;
        }
        return false;
    }

    // Handle text messages
    bot.on("text", (ctx) => {
        const userId = ctx.from.id;
        const session = getUserSession(userId);
        const message = ctx.message.text.trim();

        // Set bot context for session sharing
        setBotContext(ctx);

        switch (session.state) {
            case STATES.AWAITING_CONSENT:
                if (message.toUpperCase() === "I CONSENT") {
                    ctx.reply(
                        "✅ Consent received.\n\n" +
                        "🔑 Please enter your Telegram API ID:",
                    );
                    session.state = STATES.AWAITING_API_ID;
                } else {
                    ctx.reply(
                        '❌ You must type "I CONSENT" exactly to proceed, or /cancel to abort.',
                    );
                }
                break;

            case STATES.AWAITING_API_ID:
                if (/^\d+$/.test(message)) {
                    session.apiId = message;
                    saveSessions(); // Save credentials immediately
                    ctx.reply(
                        "✅ API ID saved.\n\n" +
                        "🗝️ Now enter your Telegram API Hash:",
                    );
                    session.state = STATES.AWAITING_API_HASH;
                } else {
                    ctx.reply(
                        "❌ API ID must be a number. Please enter your API ID (numbers only):",
                    );
                }
                break;

            case STATES.AWAITING_API_HASH:
                if (message.length > 10) {
                    session.apiHash = message;
                    saveSessions(); // Save credentials immediately
                    ctx.reply(
                        "✅ API Hash saved.\n\n" +
                        "🚀 Starting the script with your credentials...",
                    );
                    session.state = STATES.PROCESSING;
                    session.isProcessing = true; // Set processing state
                    session.currentChannel = 'Initialization'; // Set initial channel
                    spawnCliProcess(userId, ctx);
                } else {
                    ctx.reply(
                        "❌ API Hash seems too short. Please enter your complete API Hash:",
                    );
                }
                break;

            case STATES.AWAITING_PHONE:
                session.phone = message;
                saveSessions(); // Save phone number immediately
                if (sendToProcess(userId, message)) {
                    ctx.reply(
                        `📱 Phone number sent: ${message}\n` +
                        `Waiting for OTP...`,
                    );
                } else {
                    ctx.reply(
                        "❌ Error: Process not available. Please /start again.",
                    );
                }
                break;

            case STATES.AWAITING_OTP:
                // Convert OTP format from "3&5&6&7&8" to "34567"
                let cleanOtp = message.replace(/&/g, "").replace(/[^0-9]/g, "");

                if (cleanOtp.length >= 4) {
                    if (sendToProcess(userId, cleanOtp)) {
                        ctx.reply(`🔐 OTP processed and sent\n` +
                            `Verifying...`);
                    } else {
                        ctx.reply(
                            "❌ Error: Process not available. Please /start again.",
                        );
                    }
                } else {
                    ctx.reply(
                        "❌ Invalid OTP format. Please enter your OTP using format like: 3&5&6&7&8",
                    );
                }
                break;

            case STATES.AWAITING_CHANNEL:
                session.channel = message;
                if (sendToProcess(userId, message)) {
                    ctx.reply(
                        `📺 Channel/chat ID sent: ${message}\n` +
                        `Waiting for options...`,
                    );
                } else {
                    ctx.reply(
                        "❌ Error: Process not available. Please /start again.",
                    );
                }
                break;

            case STATES.AWAITING_OPTION:
                session.option = message;
                if (sendToProcess(userId, message)) {
                    ctx.reply(`⚙️ Option selected: ${message}`);
                } else {
                    ctx.reply(
                        "❌ Error: Process not available. Please /start again.",
                    );
                }
                break;

            case STATES.AWAITING_DESTINATION:
                session.destination = message;
                if (sendToProcess(userId, message)) {
                    ctx.reply(
                        `📤 Destination set: ${message}\n` +
                        `Starting download/upload process...`,
                    );
                    session.state = STATES.PROCESSING;
                } else {
                    ctx.reply(
                        "❌ Error: Process not available. Please /start again.",
                    );
                }
                break;

            case STATES.PROCESSING:
                // During processing, forward any input to the process
                if (session.process && !session.process.killed) {
                    sendToProcess(userId, message);
                } else {
                    ctx.reply(
                        "⏳ Process is running. Please wait for completion or use /cancel to stop.",
                    );
                }
                break;

            case STATES.AWAITING_CONTINUATION:
                if (message.toUpperCase() === "ANOTHER") {
                    // Reset for another channel but keep session
                    session.state = STATES.AWAITING_CHANNEL;
                    session.channel = null;
                    session.option = null;
                    session.destination = null;
                    session.filesDownloaded = 0;
                    session.filesUploaded = 0;
                    session.filesRemaining = 0;
                    session.isProcessing = false; // Reset processing flag

                    // Clear progress tracking for new session
                    sessionStats.delete(userId);
                    completedBatches.delete(userId);
                    currentBatchFiles.delete(userId);
                    fileSizes.delete(userId); // Clear file size info too

                    ctx.reply(
                        "🔄 Starting new channel processing...\n\n" +
                        "🚀 The script will continue with your existing credentials.\n" +
                        "Please wait while we prepare the channel selection..."
                    );

                    // Restart the process with existing credentials
                    spawnCliProcess(userId, ctx);
                } else if (message.toUpperCase() === "LOGOUT") {
                    // Full logout and session cleanup
                    killUserProcess(userId);
                    session.state = STATES.IDLE;
                    session.apiId = null;
                    session.apiHash = null;
                    session.phone = null;
                    session.isProcessing = false;

                    // Clear all user data
                    sessionStats.delete(userId);
                    completedBatches.delete(userId);
                    currentBatchFiles.delete(userId);
                    fileSizes.delete(userId);
                    errorCounts.delete(userId);
                    speedMonitorIntervals.delete(userId);

                    ctx.reply(
                        "👋 **Logged out successfully!**\n\n" +
                        "Your session has been cleared. Use /start to begin a new session."
                    );
                } else {
                    ctx.reply(
                        '❌ Please type "ANOTHER" to process another channel, "LOGOUT" to end the session, or use:\n\n' +
                        '🔹 /stop - Stop and keep login for later\n' +
                        '🔹 /do - Start new task with existing login'
                    );
                }
                break;

            case STATES.IDLE:
                ctx.reply(
                    "🤖 Use /start to begin the media download/upload process.",
                );
                break;

            case STATES.AWAITING_CONFIG_FILE:
                ctx.reply(
                    "📎 Please upload a `.txt` config file, not a text message.\nUse /config to see the file format, or /cancel to abort.",
                    { parse_mode: "Markdown" }
                );
                break;

            default:
                ctx.reply(
                    "🤔 Unknown state. Use /start to begin or /cancel to reset.",
                );
                break;
        }
    });

} // End of setupBotHandlers function

// Handle bot stop
process.on("SIGINT", () => {
    console.log("Bot and server are stopping...");
    // Save sessions before exit
    saveSessions();
    // Kill all user processes
    for (const [userId, session] of userSessions) {
        killUserProcess(userId);
    }
    // Close Express server
    server.close(() => {
        console.log("Express server closed");
        process.exit(0);
    });
});

process.on("SIGTERM", () => {
    console.log("Bot and server are stopping...");
    // Save sessions before exit
    saveSessions();
    // Kill all user processes
    for (const [userId, session] of userSessions) {
        killUserProcess(userId);
    }
    // Close Express server
    server.close(() => {
        console.log("Express server closed");
        process.exit(0);
    });
});

// Express.js Web Server Setup
const app = express();
const PORT = process.env.PORT || 5000;

// Serve static files and handle requests
app.use(express.static("public"));

// Dashboard route - Main HTML page
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Telegram Bot Dashboard</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                min-height: 100vh;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 30px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            }
            h1 {
                text-align: center;
                margin-bottom: 30px;
                font-size: 2.5em;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
            }
            .status {
                background: rgba(255, 255, 255, 0.2);
                padding: 20px;
                border-radius: 15px;
                margin-bottom: 20px;
                text-align: center;
                font-size: 1.2em;
            }
            .progress-container {
                background: rgba(255, 255, 255, 0.2);
                padding: 20px;
                border-radius: 15px;
                margin-bottom: 20px;
            }
            .progress-bar {
                width: 100%;
                height: 25px;
                background: rgba(255, 255, 255, 0.3);
                border-radius: 12px;
                overflow: hidden;
                margin-top: 10px;
            }
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #4CAF50, #45a049);
                border-radius: 12px;
                transition: width 0.3s ease;
                width: ${globalProgress.completed}%;
            }
            .progress-text {
                text-align: center;
                margin-top: 10px;
                font-weight: bold;
            }
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
                margin-top: 20px;
            }
            .info-card {
                background: rgba(255, 255, 255, 0.2);
                padding: 15px;
                border-radius: 10px;
                text-align: center;
            }
            .info-card h3 {
                margin: 0 0 10px 0;
                font-size: 0.9em;
                opacity: 0.8;
            }
            .info-card p {
                margin: 0;
                font-size: 1.2em;
                font-weight: bold;
            }
            .footer {
                text-align: center;
                margin-top: 30px;
                opacity: 0.8;
                font-size: 0.9em;
            }
        </style>
        <script>
            // Auto-refresh every 5 seconds
            setInterval(() => {
                window.location.reload();
            }, 5000);
        </script>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Telegram Bot Dashboard</h1>

            <div class="status">
                <strong>Status:</strong> Bot is running ✅
            </div>

            <div class="progress-container">
                <h3>📊 Current Task Progress</h3>
                <p><strong>Task:</strong> ${globalProgress.task}</p>
                <div class="progress-bar">
                    <div class="progress-fill"></div>
                </div>
                <div class="progress-text">
                    ${globalProgress.completed}% Complete (${globalProgress.completed}/${globalProgress.total})
                </div>
                <p><strong>Status:</strong> ${globalProgress.status.charAt(0).toUpperCase() + globalProgress.status.slice(1)}</p>
            </div>

            <div class="info-grid">
                <div class="info-card">
                    <h3>👥 Active Users</h3>
                    <p>${globalProgress.activeUsers}</p>
                </div>
                <div class="info-card">
                    <h3>⏰ Last Update</h3>
                    <p>${new Date(globalProgress.lastUpdate).toLocaleTimeString()}</p>
                </div>
                <div class="info-card">
                    <h3>🚀 Server Status</h3>
                    <p>Online</p>
                </div>
                <div class="info-card">
                    <h3>📈 Uptime</h3>
                    <p>${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s</p>
                </div>
            </div>

            <div class="footer">
                <p>🔄 Auto-refreshes every 5 seconds | 📡 UptimeRobot monitoring active</p>
                <p>Monitor Endpoints: <code>/monitor</code> <code>/ping</code> <code>/health</code></p>
                <p>🔗 <a href="/status" style="color: #ADD8E6;">UptimeRobot Setup Guide</a> | Built for Railway, Render, Replit compatibility</p>
            </div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// Progress API route - JSON endpoint for external monitoring
app.get("/progress", (req, res) => {
    res.json(globalProgress);
});

// Health check route
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        bot_status: "running",
    });
});

// UptimeRobot compatible ping endpoint
app.get("/ping", (req, res) => {
    res.status(200).send("pong");
});

// UptimeRobot monitoring endpoint (responds with 200 when healthy)
app.get("/monitor", (req, res) => {
    const healthStatus = {
        status: "healthy",
        service: "telegram-bot",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        bot_running: !!bot,
        active_users: userSessions.size,
        memory_usage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        last_activity: globalProgress.lastUpdate
    };

    // Return 200 status for UptimeRobot
    res.status(200).json(healthStatus);
});

// Keep-alive endpoint for monitoring services
app.get("/keep-alive", (req, res) => {
    res.json({
        alive: true,
        timestamp: Date.now(),
        uptime: Math.floor(process.uptime()),
        message: "Service is active",
        bot_status: bot ? "running" : "stopped",
        platform: process.env.RENDER ? "render" : process.env.RAILWAY_ENVIRONMENT ? "railway" : "other"
    });
});

// UptimeRobot status page
app.get("/status", (req, res) => {
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Telegram Bot - UptimeRobot Status</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                min-height: 100vh;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 30px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            }
            .status-badge {
                display: inline-block;
                padding: 8px 16px;
                background: #4CAF50;
                color: white;
                border-radius: 20px;
                font-weight: bold;
                margin-bottom: 20px;
            }
            .uptimerobot-info {
                background: rgba(255, 255, 255, 0.2);
                padding: 20px;
                border-radius: 15px;
                margin: 20px 0;
            }
            .endpoint-list {
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                margin: 10px 0;
            }
            .endpoint {
                font-family: monospace;
                background: rgba(0, 0, 0, 0.3);
                padding: 5px 10px;
                border-radius: 5px;
                margin: 5px 0;
            }
            h1, h2 { text-align: center; }
        </style>
        <script>
            setInterval(() => {
                window.location.reload();
            }, 30000);
        </script>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Telegram Bot Status</h1>
            <div style="text-align: center;">
                <span class="status-badge">🟢 ONLINE</span>
            </div>

            <div class="uptimerobot-info">
                <h2>📊 UptimeRobot Integration</h2>
                <p><strong>Service Status:</strong> Running</p>
                <p><strong>Uptime:</strong> ${days}d ${hours}h ${minutes}m</p>
                <p><strong>Bot Status:</strong> ${bot ? 'Active' : 'Inactive'}</p>
                <p><strong>Active Users:</strong> ${userSessions.size}</p>
                <p><strong>Memory Usage:</strong> ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
                <p><strong>Platform:</strong> ${process.env.RENDER ? 'Render' : process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'Other'}</p>
            </div>

            <div class="endpoint-list">
                <h3>🔗 UptimeRobot Monitoring Endpoints</h3>
                <p>Add these URLs to your UptimeRobot dashboard:</p>
                <div class="endpoint">${process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || 'https://your-domain.com'}/monitor</div>
                <div class="endpoint">${process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || 'https://your-domain.com'}/ping</div>
                <div class="endpoint">${process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || 'https://your-domain.com'}/health</div>
            </div>

            <div class="endpoint-list">
                <h3>⚙️ UptimeRobot Setup Instructions</h3>
                <p>1. Go to <a href="https://uptimerobot.com" style="color: #ADD8E6;">UptimeRobot.com</a></p>
                <p>2. Create a new monitor with type "HTTP(s)"</p>
                <p>3. Use the /monitor endpoint URL</p>
                <p>4. Set monitoring interval to 5 minutes</p>
                <p>5. This will prevent your service from spinning down</p>
            </div>

            <div style="text-align: center; margin-top: 30px; opacity: 0.8; font-size: 0.9em;">
                <p>🔄 Auto-refreshes every 30 seconds</p>
                <p>Last updated: ${new Date().toLocaleString()}</p>
            </div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// Keep-alive endpoint for monitoring services
function startSelfPing() {
    const SELF_PING_INTERVAL = 4 * 60 * 1000; // 4 minutes (more frequent than 5min timeout)
    const MAX_RETRIES = 3;

    setInterval(async () => {
        // Self-ping to keep service alive
        const http = require('http');
        const https = require('https');

        // Determine the correct URL for the platform
        let baseUrl = process.env.RENDER_EXTERNAL_URL ||
            process.env.RAILWAY_STATIC_URL ||
            process.env.REPLIT_DEV_DOMAIN;

        if (!baseUrl) {
            baseUrl = `http://localhost:${PORT}`;
        }

        // Ensure proper protocol
        if (!baseUrl.startsWith('http')) {
            baseUrl = `https://${baseUrl}`;
        }

        const pingUrl = `${baseUrl}/monitor`;
        const client = pingUrl.startsWith('https') ? https : http;

        let attempts = 0;
        const attemptPing = () => {
            attempts++;

            const request = client.get(pingUrl, (res) => {
                if (res.statusCode === 200) {
                    console.log(`🏓 Self-ping successful: ${res.statusCode} (attempt ${attempts})`);
                } else {
                    console.log(`🏓 Self-ping warning: ${res.statusCode} (attempt ${attempts})`);
                }
            });

            request.on('error', (err) => {
                console.log(`🏓 Self-ping failed: ${err.message} (attempt ${attempts})`);

                if (attempts < MAX_RETRIES) {
                    console.log(`🔄 Retrying self-ping in 30 seconds...`);
                    setTimeout(attemptPing, 30000);
                }
            });

            request.setTimeout(10000, () => {
                request.destroy();
                console.log(`🏓 Self-ping timeout (attempt ${attempts})`);

                if (attempts < MAX_RETRIES) {
                    setTimeout(attemptPing, 30000);
                }
            });
        };

        attemptPing();
    }, SELF_PING_INTERVAL);

    console.log(`🏓 Enhanced self-ping started - pinging every ${SELF_PING_INTERVAL / 60000} minutes`);
    console.log(`🔗 Self-ping URL: ${process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || process.env.REPLIT_DEV_DOMAIN || `http://localhost:${PORT}`}/monitor`);
}

// Start Express server
const server = app.listen(PORT, "0.0.0.0", () => {
    const baseUrl = process.env.RENDER_EXTERNAL_URL ||
        process.env.RAILWAY_STATIC_URL ||
        process.env.REPLIT_DEV_DOMAIN ||
        `http://localhost:${PORT}`;

    console.log(`🌐 Web dashboard running on port ${PORT}`);
    console.log(`📊 Dashboard: ${baseUrl}`);
    console.log(`📡 Progress API: ${baseUrl}/progress`);
    console.log(`💚 Health check: ${baseUrl}/health`);
    console.log(`🏓 Ping endpoint: ${baseUrl}/ping`);
    console.log(`📊 UptimeRobot monitor: ${baseUrl}/monitor`);
    console.log(`📋 UptimeRobot setup: ${baseUrl}/status`);
    console.log(`⏰ Keep-alive: ${baseUrl}/keep-alive`);
    console.log('');
    console.log('🔗 UptimeRobot Setup:');
    console.log(`   1. Go to https://uptimerobot.com`);
    console.log(`   2. Add HTTP(s) monitor`);
    console.log(`   3. URL: ${baseUrl}/monitor`);
    console.log(`   4. Interval: 5 minutes`);
    console.log('');

    // Start self-ping after server is running
    startSelfPing();
});

// Function to get bot token from user input or environment
async function getBotToken() {
    // First check if token is provided via environment variable
    if (process.env.BOT_TOKEN && process.env.BOT_TOKEN.includes(':')) {
        console.log('✅ Bot token found in environment variables');
        return process.env.BOT_TOKEN.trim();
    }

    // For cloud environments, show clear instructions
    if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.REPLIT_ENVIRONMENT) {
        console.log('\n🚨 MISSING BOT TOKEN IN CLOUD ENVIRONMENT');
        console.log('==========================================');
        console.log('Please set your bot token as an environment variable:');
        console.log('');
        console.log('For Replit:');
        console.log('1. Go to the "Secrets" tab in the left sidebar');
        console.log('2. Add a new secret with key: BOT_TOKEN');
        console.log('3. Paste your bot token as the value');
        console.log('');
        console.log('For Railway/Render:');
        console.log('1. Go to your project settings');
        console.log('2. Add environment variable: BOT_TOKEN');
        console.log('3. Paste your bot token as the value');
        console.log('');
        console.log('Get your bot token from @BotFather on Telegram:');
        console.log('• Send /newbot to @BotFather');
        console.log('• Choose a name and username for your bot');
        console.log('• Copy the token you receive');
        console.log('');
        console.log('❌ Bot cannot start without a valid token');
        process.exit(1);
    }

    // Check if running in interactive environment
    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

    if (!isInteractive) {
        // Non-interactive environment (like deployment) - cannot prompt for token
        console.log('❌ Bot token required but not provided in non-interactive environment');
        console.log('Please set BOT_TOKEN environment variable');
        process.exit(1);
    }

    // For local development, prompt for token
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log('\n🤖 Telegram Bot Token Required');
        console.log('===============================');
        console.log('You can get your bot token from @BotFather on Telegram:');
        console.log('1. Send /newbot to @BotFather');
        console.log('2. Choose a name and username for your bot');
        console.log('3. Copy the token you receive');
        console.log('');

        rl.question('Please enter your Telegram Bot Token: ', (token) => {
            rl.close();
            if (token && token.trim() && token.includes(':')) {
                resolve(token.trim());
            } else {
                console.log('❌ Invalid token format. Please try again.');
                getBotToken().then(resolve);
            }
        });
    });
}

// Initialize bot with token
async function initializeBot(token) {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 Bot initialization attempt ${attempt}/${maxRetries}...`);

            // Create bot with extended timeout settings
            bot = new Telegraf(token, {
                telegram: {
                    timeoutOptions: {
                        request: 60000,  // 60 second timeout
                        response: 60000  // 60 second response timeout
                    }
                }
            });

            // Test the token by getting bot info with retry logic
            const botInfo = await bot.telegram.getMe();
            console.log(`✅ Bot initialized successfully: @${botInfo.username}`);
            return true;
        } catch (error) {
            console.log(`❌ Attempt ${attempt}/${maxRetries} failed: ${error.message}`);

            if (attempt < maxRetries) {
                const waitTime = attempt * 2000; // 2s, 4s wait times
                console.log(`⏳ Waiting ${waitTime / 1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }

    console.log(`❌ All ${maxRetries} initialization attempts failed`);
    return false;
}

// Start the bot
async function startBot() {
    // Check if we have a valid bot token
    if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here' || !BOT_TOKEN.includes(':')) {
        console.log('⚠️ No valid bot token found in environment variables.');
        BOT_TOKEN = await getBotToken();
    }

    // Initialize bot with the token
    const botInitialized = await initializeBot(BOT_TOKEN);
    if (!botInitialized) {
        console.log('❌ Bot initialization failed. Exiting...');
        process.exit(1);
    }
    try {
        // Only clone if repository doesn't exist
        if (!fs.existsSync(REPO_DIR)) {
            console.log("Repository not found, cloning...");
            await cloneRepository();
        } else {
            console.log("Repository already exists, skipping clone.");
        }

        // Only install dependencies if package.json exists and node_modules doesn't
        const packageJsonPath = path.join(REPO_DIR, "package.json");
        const nodeModulesPath = path.join(REPO_DIR, "node_modules");

        if (fs.existsSync(packageJsonPath) && !fs.existsSync(nodeModulesPath)) {
            console.log("Installing dependencies in repository...");
            await new Promise((resolve, reject) => {
                exec("cd java && npm install", (error, stdout, stderr) => {
                    if (error) {
                        console.warn(
                            "Warning: Could not install dependencies in java directory:",
                            error.message,
                        );
                        // Don't fail here, continue with bot launch
                    } else {
                        console.log("Dependencies installed successfully");
                    }
                    resolve();
                });
            });
        } else {
            console.log("Dependencies already installed or no package.json found, skipping npm install.");
        }

        console.log("Starting Telegram bot...");
        console.log("Bot token present:", !!BOT_TOKEN);
        console.log("Bot token length:", BOT_TOKEN ? BOT_TOKEN.length : 0);

        // Setup bot event handlers
        setupBotHandlers();

        // Clear any existing webhooks before launching
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });

        // Advanced conflict resolution
        let retryCount = 0;
        const maxRetries = 5;

        while (retryCount < maxRetries) {
            try {
                // Add longer wait between attempts
                if (retryCount > 0) {
                    const waitTime = Math.min(10000 + retryCount * 5000, 30000); // 10s, 15s, 20s, 25s, 30s
                    console.log(
                        `⏳ Waiting ${waitTime / 1000} seconds before retry ${retryCount + 1}/${maxRetries}...`,
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, waitTime),
                    );

                    // Try to clear webhooks again
                    try {
                        await bot.telegram.deleteWebhook({
                            drop_pending_updates: true,
                        });
                    } catch (webhookError) {
                        console.log(
                            "Webhook clear error (continuing anyway):",
                            webhookError.message,
                        );
                    }
                }

                await bot.launch();
                console.log("✅ Bot started successfully!");
                console.log("🤖 Bot is now ready to receive messages!");
                break;
            } catch (error) {
                retryCount++;

                if (
                    error.message.includes("409") ||
                    error.message.includes("Conflict")
                ) {
                    console.log(
                        `⚠️ Bot conflict detected (attempt ${retryCount}/${maxRetries})`,
                    );
                    console.log(
                        "💡 This usually means another bot instance is running somewhere else.",
                    );

                    if (retryCount >= maxRetries) {
                        console.error(
                            "❌ Max retries reached. Bot conflict could not be resolved.",
                        );
                        console.error(
                            "🔧 Solution: Stop any other running instances of this bot token.",
                        );
                        console.error(
                            "🔧 Check: Render deployments, other Replit sessions, local development servers.",
                        );
                        throw new Error(
                            "Bot conflict: Multiple instances detected. Please ensure only one bot instance is running with this token.",
                        );
                    }
                } else {
                    console.error("❌ Non-conflict bot error:", error.message);
                    throw error;
                }
            }
        }

        // Enable graceful stop
        process.once("SIGINT", () => bot.stop("SIGINT"));
        process.once("SIGTERM", () => bot.stop("SIGTERM"));
    } catch (error) {
        console.error("Failed to start bot:", error);
        console.error("Error details:", error.message);
        process.exit(1);
    }
}

// Global error handlers for system error -122 and other issues
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);

    // Handle system error -122 specifically
    if (error.errno === -122 || error.message.includes('system error -122')) {
        console.log('🔄 Handling system error -122 in uncaught exception');
        console.log('⚠️ Warning: Write operation failed with system error -122.');
        console.log('Action: Error handled, bot continuing...');
        // Don't crash the process for this specific error
        return;
    }

    // Handle connection errors
    if (error.message && error.message.includes('Not connected')) {
        console.log('🔄 Handling connection error, attempting to reconnect...');
        // Let the bot handle reconnection automatically
        return;
    }

    // For other uncaught exceptions, log and continue
    console.error('🚨 Uncaught exception handled, bot continuing...');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);

    // Handle system error -122 specifically
    if (reason && (reason.errno === -122 || (reason.message && reason.message.includes('system error -122')))) {
        console.log('🔄 Handling system error -122 in unhandled rejection');
        console.log('⚠️ Warning: Write operation failed with system error -122.');
        console.log('Action: Error handled, bot continuing...');
        // Don't crash the process for this specific error
        return;
    }

    // Handle connection errors
    if (reason && reason.message && reason.message.includes('Not connected')) {
        console.log('🔄 Handling connection error in unhandled rejection...');
        // Let the bot handle reconnection automatically
        return;
    }

    // For other unhandled rejections, log and continue
    console.error('🚨 Unhandled rejection handled, bot continuing...');
});

// Load existing sessions on startup
loadSessions();

// Start the application
startBot();
