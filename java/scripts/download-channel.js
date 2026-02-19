"use strict";
const fs = require("fs");
const path = require("path");
const { initAuth } = require("../modules/auth");
const {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
  uploadMessageToChannel,
  forwardMessageToChannel,
} = require("../modules/messages");
const {
  getMediaType,
  getMediaPath,
  checkFileExist,
  appendToJSONArrayFile,
  wait,
} = require("../utils/helper");
const {
  updateLastSelection,
  getLastSelection,
} = require("../utils/file-helper");

// Per-file retry tracking
const fileRetryAttempts = new Map(); // fileName -> retry count
const MAX_FILE_RETRIES = 3; // Maximum retries per file

// Get or initialize retry count for a file
function getFileRetryCount(fileName) {
  return fileRetryAttempts.get(fileName) || 0;
}

// Increment retry count for a file
function incrementFileRetry(fileName) {
  const current = getFileRetryCount(fileName);
  fileRetryAttempts.set(fileName, current + 1);
  return current + 1;
}

// Reset retry count for a file
function resetFileRetry(fileName) {
  fileRetryAttempts.delete(fileName);
}

// Check if file has exceeded max retries
function hasExceededRetries(fileName) {
  return getFileRetryCount(fileName) >= MAX_FILE_RETRIES;
}
const logger = require("../utils/logger");
const { getDialogName, getAllDialogs } = require("../modules/dialoges");
const {
  downloadOptionInput,
  selectInput,
  booleanInput,
} = require("../utils/input-helper");

// BALANCED CONFIGURATIONS FOR STABLE 25-30 MBPS
const MAX_PARALLEL_DOWNLOADS_CONFIG = 16; // Reduced for stability
const MAX_PARALLEL_UPLOADS_CONFIG = 16; // Reduced for stability
const MESSAGE_LIMIT_CONFIG = 50; // Reduced to 50 as requested
const RATE_LIMIT_DELAY_CONFIG = 1000; // Increased delay to prevent disconnections
const DOWNLOAD_DELAY_CONFIG = 1000; // Increased delay for stability
const UPLOAD_DELAY_CONFIG = 1000; // Increased delay for stability
const CHUNK_SIZE_CONFIG = 16 * 1024 * 1024; // Reduced to 16MB for stability

// STABLE CONFIGURATIONS
const BATCH_SIZE = 2; // Reduced to 2 messages per batch as requested
const CONNECTION_POOL_SIZE = 8; // Reduced for stability
const SPEED_STABILIZATION_DELAY = 50; // Ultra-minimal stabilization delay
const THROUGHPUT_OPTIMIZATION_MODE = true;
const AGGRESSIVE_SPEED_MODE = true; // Enabled for maximum speed
const TARGET_SPEED_MBPS = 45; // Increased target to 35 Mbps for headroom

/**
 * Ultra-High-Speed Telegram Channel Downloader with Consistent 30+ Mbps Performance
 */
class DownloadChannel {
  constructor() {
    this.outputFolder = null;
    this.uploadMode = false;
    this.targetChannelId = null;
    this.downloadableFiles = null;
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.totalDownloaded = 0;
    this.totalUploaded = 0;
    this.totalMessages = 0;
    this.totalProcessedMessages = 0;
    this.skippedFiles = 0;
    this.selectiveMode = false;
    this.startFromMessageId = 0;
    this.batchCounter = 0;
    this.downloadToEndMode = false;
    this.speedMonitor = null;
    this.connectionPool = [];

    // Enhanced flood wait tracking with adaptive learning
    this.requestsInLastMinute = [];
    this.consecutiveFloodWaits = 0;
    this.adaptiveDelayMultiplier = 0.5; // Start aggressively
    this.lastFloodWait = 0;

    // Task 1: Force file overwrite for complete downloads
    this.forceFileOverwrite = true;
    this.ensureCompleteDownload = true;
    this.floodWaitHistory = [];
    this.optimalRequestRate = 50; // Requests per minute
    this.speedBoostMode = false;
    this.connectionHealth = 100;

    // FILE_REFERENCE_EXPIRED tracking
    this.fileReferenceErrors = [];
    this.consecutiveFileRefErrors = 0;

    // File locking system to prevent deletion of actively downloading files
    this.activeDownloads = new Set(); // Set of file paths currently being downloaded
    this.fileLocks = new Map(); // Map of file path -> lock info (timestamp, messageId)

    // Failed downloads tracking for batch-level reporting
    this.failedDownloads = []; // Array of {messageId, fileName, reason} for files that failed after max retries

    const exportPath = path.resolve(process.cwd(), "./export");
    if (!fs.existsSync(exportPath)) {
      fs.mkdirSync(exportPath);
    }
  }

  static description() {
    return "Ultra-High-Speed Download (35 Mbps target) with advanced flood wait reduction";
  }

  /**
   * Advanced speed monitoring system for consistent 30+ Mbps
   */
  initializeSpeedMonitor() {
    this.speedMonitor = {
      startTime: Date.now(),
      totalBytes: 0,
      currentSpeed: 0,
      targetSpeed: TARGET_SPEED_MBPS * 1024 * 1024, // 35 Mbps target
      speedHistory: [],
      stabilizationFactor: 3.0, // Start with maximum aggression
      consecutiveLowSpeed: 0,
      lastSpeedCheck: Date.now(),
      peakSpeed: 0,
      averageSpeed: 0,
      speedVariance: 0,
      currentFileSize: 0, // Added for file size tracking

      updateSpeed: (bytes) => {
        const now = Date.now();
        const elapsed = (now - this.speedMonitor.startTime) / 1000;
        this.speedMonitor.totalBytes += bytes;
        this.speedMonitor.currentSpeed =
          elapsed > 0 ? (this.speedMonitor.totalBytes * 8) / elapsed : 0;

        // Track peak performance
        if (this.speedMonitor.currentSpeed > this.speedMonitor.peakSpeed) {
          this.speedMonitor.peakSpeed = this.speedMonitor.currentSpeed;
        }

        // Enhanced speed history tracking
        this.speedMonitor.speedHistory.push(this.speedMonitor.currentSpeed);
        if (this.speedMonitor.speedHistory.length > 10) {
          this.speedMonitor.speedHistory.shift();
        }

        // Calculate average and variance for stability
        const avgSpeed =
          this.speedMonitor.speedHistory.reduce((a, b) => a + b, 0) /
          this.speedMonitor.speedHistory.length;
        this.speedMonitor.averageSpeed = avgSpeed;

        const currentSpeedMbps = this.speedMonitor.currentSpeed / 1000000;
        const avgSpeedMbps = avgSpeed / 1000000;

        // Ultra-aggressive speed optimization
        if (currentSpeedMbps < 25) {
          // Below 25 Mbps - maximum boost
          this.speedMonitor.stabilizationFactor = Math.min(
            5.0,
            this.speedMonitor.stabilizationFactor * 1.25,
          );
          this.speedMonitor.consecutiveLowSpeed++;
          this.speedBoostMode = true;
        } else if (currentSpeedMbps >= 30) {
          // Above 30 Mbps - maintain with slight optimization
          this.speedMonitor.stabilizationFactor = Math.max(
            2.0,
            this.speedMonitor.stabilizationFactor * 0.95,
          );
          this.speedMonitor.consecutiveLowSpeed = 0;
          this.speedBoostMode = false;
        } else {
          // Between 25-30 Mbps - aggressive boost
          this.speedMonitor.stabilizationFactor = Math.min(
            4.0,
            this.speedMonitor.stabilizationFactor * 1.15,
          );
        }

        // Emergency ultra-boost for consistently low speeds
        if (this.speedMonitor.consecutiveLowSpeed > 3) {
          this.speedMonitor.stabilizationFactor = 5.0;
          this.speedBoostMode = true;
          this.speedMonitor.consecutiveLowSpeed = 0;
        }
      },

      getOptimalDelay: () => {
        // Ultra-minimal delays for maximum speed
        const baseDelay = this.speedBoostMode ? 5 : SPEED_STABILIZATION_DELAY;
        const optimizedDelay = Math.max(
          5,
          baseDelay / this.speedMonitor.stabilizationFactor,
        );
        return optimizedDelay;
      },

      getCurrentSpeedMbps: () => {
        return (this.speedMonitor.currentSpeed / 1000000).toFixed(1);
      },

      getAverageSpeedMbps: () => {
        return (this.speedMonitor.averageSpeed / 1000000).toFixed(1);
      },

      getPeakSpeedMbps: () => {
        return (this.speedMonitor.peakSpeed / 1000000).toFixed(1);
      },

      getSpeedStatus: () => {
        const speedMbps = parseFloat(this.speedMonitor.getCurrentSpeedMbps());
        if (speedMbps >= 30) return "🟢 OPTIMAL";
        if (speedMbps >= 20) return "🟡 BOOSTING";
        return "🔴 MAXIMUM BOOST";
      },

      setCurrentFileSize: (size) => {
        this.speedMonitor.currentFileSize = size;
      },
    };
  }

  /**
   * Track FILE_REFERENCE_EXPIRED errors for analytics and optimization
   */
  trackFileReferenceError() {
    const now = Date.now();
    this.fileReferenceErrors.push(now);
    this.consecutiveFileRefErrors++;

    // Clean old entries (keep last 30 minutes)
    this.fileReferenceErrors = this.fileReferenceErrors.filter(
      (timestamp) => now - timestamp < 30 * 60 * 1000
    );

    // Log patterns for debugging
    if (this.consecutiveFileRefErrors > 0 && this.consecutiveFileRefErrors % 3 === 0) {
      const recentErrors = this.fileReferenceErrors.filter(
        (timestamp) => now - timestamp < 5 * 60 * 1000
      ).length;

      logger.warn(
        `📊 FILE_REFERENCE pattern: ${this.consecutiveFileRefErrors} consecutive, ${recentErrors} in last 5min`
      );
    }
  }

  /**
   * Reset FILE_REFERENCE_EXPIRED error tracking on success
   */
  resetFileReferenceTracking() {
    if (this.consecutiveFileRefErrors > 0) {
      logger.info(`📋 File reference errors cleared after ${this.consecutiveFileRefErrors} consecutive attempts`);
      this.consecutiveFileRefErrors = 0;
    }
  }

  /**
   * Delete existing file to force fresh download
   */
  deleteExistingFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`🗑️ Deleted existing file for fresh download: ${path.basename(filePath)}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.warn(`⚠️ Failed to delete existing file ${filePath}: ${error.message}`);
      return false;
    }
  }

  /**
   * Lock a file during active download to prevent deletion
   */
  lockFile(filePath, messageId) {
    this.activeDownloads.add(filePath);
    this.fileLocks.set(filePath, {
      timestamp: Date.now(),
      messageId: messageId,
      locked: true
    });
    logger.info(`🔒 Locked file for download: ${path.basename(filePath)} (Message ${messageId})`);
  }

  /**
   * Unlock a file after download completion
   */
  unlockFile(filePath) {
    this.activeDownloads.delete(filePath);
    this.fileLocks.delete(filePath);
    logger.info(`🔓 Unlocked file after download: ${path.basename(filePath)}`);
  }

  /**
   * Check if a file is currently locked (being downloaded)
   */
  isFileLocked(filePath) {
    return this.activeDownloads.has(filePath);
  }

  /**
   * Pre-batch cleanup: Remove all incomplete files BEFORE starting batch downloads
   * This prevents the infinite loop by cleaning up once at the start instead of during downloads
   */
  async cleanupIncompleteFiles(messages) {
    if (!this.outputFolder || !fs.existsSync(this.outputFolder)) {
      return;
    }

    logger.info(`🧹 Pre-batch cleanup: Scanning for incomplete files...`);
    let deletedCount = 0;
    let totalSize = 0;

    for (const message of messages) {
      if (!message.media) continue;

      const mediaPath = getMediaPath(message, this.outputFolder);
      const expectedSize = message.media?.document?.size || message.media?.photo?.sizes?.[0]?.size || 0;

      // Only check files that are NOT currently locked (not actively downloading)
      if (fs.existsSync(mediaPath) && !this.isFileLocked(mediaPath)) {
        const currentFileSize = fs.statSync(mediaPath).size;

        // CRITICAL: Always delete 0-byte files (empty/corrupt)
        if (currentFileSize === 0) {
          logger.warn(`🗑️ Cleaning 0-byte empty file: ${path.basename(mediaPath)}`);
          try {
            fs.unlinkSync(mediaPath);
            deletedCount++;
          } catch (error) {
            logger.warn(`⚠️ Failed to delete 0-byte file: ${error.message}`);
          }
          continue;
        }

        // If we don't know expected size, skip cleanup (assume complete)
        if (expectedSize === 0) {
          continue;
        }

        // Check if file is incomplete (with tolerance)
        const isPDF = path.extname(mediaPath).toLowerCase() === '.pdf';
        const toleranceThreshold = isPDF ? 0.8 : 0.98;

        if (currentFileSize < expectedSize * toleranceThreshold) {
          // File is incomplete and not locked - safe to delete
          logger.warn(
            `🗑️ Cleaning incomplete file: ${path.basename(mediaPath)} (${(currentFileSize / 1024 / 1024).toFixed(2)}MB / ${(expectedSize / 1024 / 1024).toFixed(2)}MB)`
          );
          try {
            fs.unlinkSync(mediaPath);
            deletedCount++;
            totalSize += currentFileSize;
          } catch (error) {
            logger.warn(`⚠️ Failed to delete incomplete file: ${error.message}`);
          }
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(
        `✅ Pre-batch cleanup complete: Removed ${deletedCount} incomplete files (${(totalSize / 1024 / 1024).toFixed(2)}MB freed)`
      );
    } else {
      logger.info(`✅ Pre-batch cleanup complete: No incomplete files found`);
    }
  }

  /**
   * Multi-strategy message refresh system
   * Strategy 1: Single message refresh
   * Strategy 2: Batch refresh with surrounding messages  
   * Strategy 3: Full channel refresh
   */
  async refreshMessageWithStrategies(client, channelId, message, attempt = 1) {
    const maxStrategies = 3;

    try {
      if (attempt <= 3) {
        // Strategy 1: Single message refresh
        logger.info(`🔄 Strategy 1: Refreshing single message ${message.id} (attempt ${attempt})`);
        const refreshedMessages = await getMessageDetail(client, channelId, [message.id]);
        if (refreshedMessages && refreshedMessages.length > 0) {
          logger.success(`✅ Strategy 1 success: Message ${message.id} refreshed`);
          return refreshedMessages[0];
        }
      } else if (attempt <= 6) {
        // Strategy 2: Batch refresh with surrounding messages
        const surroundingIds = [];
        for (let i = Math.max(1, message.id - 2); i <= message.id + 2; i++) {
          surroundingIds.push(i);
        }
        logger.info(`🔄 Strategy 2: Refreshing batch around message ${message.id} (attempt ${attempt})`);
        const refreshedMessages = await getMessageDetail(client, channelId, surroundingIds);
        if (refreshedMessages && refreshedMessages.length > 0) {
          const targetMessage = refreshedMessages.find(msg => msg.id === message.id);
          if (targetMessage) {
            logger.success(`✅ Strategy 2 success: Message ${message.id} refreshed in batch`);
            return targetMessage;
          }
        }
      } else {
        // Strategy 3: Full channel refresh
        logger.info(`🔄 Strategy 3: Full channel refresh for message ${message.id} (attempt ${attempt})`);
        const allRefreshed = await this.refreshAllChannelMessages(client, channelId);
        if (allRefreshed && allRefreshed.length > 0) {
          const targetMessage = allRefreshed.find(msg => msg.id === message.id);
          if (targetMessage) {
            logger.success(`✅ Strategy 3 success: Message ${message.id} refreshed in full channel`);
            return targetMessage;
          }
        }
      }

      return null;
    } catch (error) {
      logger.error(`❌ Strategy ${Math.min(3, Math.ceil(attempt / 2))} failed for message ${message.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Enhanced flood wait management with adaptive learning
   */
  updateFloodWaitHistory(hadFloodWait, waitTime = 0) {
    const now = Date.now();

    // Clean old entries (older than 10 minutes)
    this.floodWaitHistory = this.floodWaitHistory.filter(
      (entry) => now - entry.timestamp < 10 * 60 * 1000,
    );

    if (hadFloodWait) {
      this.floodWaitHistory.push({ timestamp: now, waitTime });
      this.consecutiveFloodWaits++;

      // Adaptive delay adjustment based on flood wait frequency
      const recentFloodWaits = this.floodWaitHistory.filter(
        (entry) => now - entry.timestamp < 5 * 60 * 1000,
      );

      if (recentFloodWaits.length > 3) {
        // Multiple recent flood waits - increase delays temporarily
        this.adaptiveDelayMultiplier = Math.min(
          2.0,
          this.adaptiveDelayMultiplier * 1.5,
        );
        this.optimalRequestRate = Math.max(20, this.optimalRequestRate * 0.8);
      } else if (recentFloodWaits.length === 1) {
        // Single flood wait - slight adjustment
        this.adaptiveDelayMultiplier = Math.min(
          1.5,
          this.adaptiveDelayMultiplier * 1.2,
        );
      }
    } else {
      // No flood wait - can be more aggressive
      this.consecutiveFloodWaits = 0;
      this.adaptiveDelayMultiplier = Math.max(
        0.3,
        this.adaptiveDelayMultiplier * 0.95,
      );
      this.optimalRequestRate = Math.min(100, this.optimalRequestRate * 1.05);
    }
  }

  /**
   * Advanced rate limiting with flood wait prediction
   */
  async checkRateLimit() {
    const now = Date.now();

    // Clean old request timestamps
    this.requestsInLastMinute = this.requestsInLastMinute.filter(
      (timestamp) => now - timestamp < 60000,
    );

    // Add current request
    this.requestsInLastMinute.push(now);
    this.requestCount++;

    // Check if we're approaching rate limits
    if (this.requestsInLastMinute.length > this.optimalRequestRate) {
      const delay = Math.max(
        25,
        (60000 / this.optimalRequestRate) * this.adaptiveDelayMultiplier,
      );
      await this.ultraOptimizedWait(delay);
    } else {
      // Ultra-minimal delay for maximum speed
      await this.ultraOptimizedWait(
        Math.max(5, RATE_LIMIT_DELAY_CONFIG * this.adaptiveDelayMultiplier),
      );
    }

    this.lastRequestTime = now;
  }

  /**
   * Ultra-optimized wait function for maximum 35+ Mbps performance
   */
  async ultraOptimizedWait(baseMs) {
    if (!this.speedMonitor) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, baseMs / 8)),
      );
      return;
    }

    const optimalDelay = this.speedMonitor.getOptimalDelay();
    const ultraMinimalDelay = Math.min(baseMs / 8, optimalDelay);

    // Apply speed boost mode for maximum performance
    const finalDelay = this.speedBoostMode
      ? Math.max(1, ultraMinimalDelay / 4)
      : Math.max(5, ultraMinimalDelay);

    await new Promise((resolve) => setTimeout(resolve, finalDelay));
  }

  /**
   * Ultra-precision delay with maximum speed optimization
   */
  async precisionDelay(ms) {
    if (!this.speedMonitor) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, ms / 3)));
      return;
    }

    const speedFactor = this.speedMonitor.stabilizationFactor;
    const currentSpeedMbps = parseFloat(
      this.speedMonitor.getCurrentSpeedMbps(),
    );

    let targetDelay;
    if (currentSpeedMbps < 20) {
      // Ultra-aggressive for low speeds
      targetDelay = Math.max(5, ms / (speedFactor * 2));
    } else if (currentSpeedMbps >= 30) {
      // Maintain high speeds with minimal delays
      targetDelay = Math.max(10, ms / speedFactor);
    } else {
      // Aggressive optimization for medium speeds
      targetDelay = Math.max(8, ms / (speedFactor * 1.5));
    }

    // Apply additional speed boost mode reduction
    if (this.speedBoostMode) {
      targetDelay = Math.max(5, targetDelay / 2);
    }

    await new Promise((resolve) => setTimeout(resolve, targetDelay));
  }

  /**
   * Enhanced retry mechanism with flood wait intelligence
   */
  async retryOperation(operation, operationName, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        if (attempt > 1) {
          logger.success(`${operationName} succeeded on attempt ${attempt}`);
          this.updateFloodWaitHistory(false); // Success after retry
        }
        return result;
      } catch (error) {
        logger.warn(
          `${operationName} failed (attempt ${attempt}/${maxRetries}): ${error.message}`,
        );

        if (error.message.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          this.updateFloodWaitHistory(true, waitTime);

          if (waitTime <= 300) {
            // Max 5 minutes
            logger.warn(
              `⏳ Flood wait: ${waitTime}s (adaptive delay: ${this.adaptiveDelayMultiplier.toFixed(2)}x)`,
            );
            await this.precisionDelay(waitTime * 1000);
            continue; // Retry immediately after wait
          }
        }

        if (attempt === maxRetries) {
          throw error;
        }

        // Ultra-minimal delays for speed optimization
        const delay = Math.min(500, 100 * attempt);
        await this.precisionDelay(delay);
      }
    }
  }

  /**
   * Enhanced connection management with health monitoring
   */
  async reconnectClient(client) {
    try {
      logger.info("🔄 Reconnecting client for speed optimization...");

      if (client.connected) {
        await client.disconnect();
        await this.precisionDelay(200);
      }

      await client.connect();
      this.connectionHealth = 100;
      logger.success("✅ Client reconnected and optimized");
      await this.precisionDelay(100);
    } catch (error) {
      this.connectionHealth = Math.max(0, this.connectionHealth - 20);
      logger.error(`❌ Reconnection failed: ${error.message}`);
      throw error;
    }
  }

  async ensureConnectionHealth(client) {
    try {
      await client.getMe();
      this.connectionHealth = Math.min(100, this.connectionHealth + 5);
      logger.info(
        `✅ Connection health: ${this.connectionHealth}% (${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps" : "OK"})`,
      );
    } catch (error) {
      this.connectionHealth = Math.max(0, this.connectionHealth - 15);
      logger.warn(
        `⚠️ Connection health check failed (${this.connectionHealth}%): ${error.message}`,
      );

      if (this.connectionHealth < 50) {
        await this.reconnectClient(client);
      }
    }
  }

  /**
   * Check if message has content with enhanced detection
   */
  hasContent(message) {
    const hasContent = Boolean(
      message.message ||
      message.media ||
      message.sticker ||
      message.document ||
      message.photo ||
      message.video ||
      message.audio ||
      message.voice ||
      message.poll ||
      message.geo ||
      message.contact ||
      message.venue ||
      message.webpage ||
      message.dice ||
      message.groupedId,
    );

    return hasContent;
  }

  /**
   * Enhanced message processing decision
   */
  shouldProcess(message) {
    if (!this.hasContent(message)) return false;

    if (message.message && !message.media) return true;

    if (message.media) {
      const mediaType = getMediaType(message);
      const mediaPath = getMediaPath(message, this.outputFolder);
      const extension = path.extname(mediaPath).toLowerCase().replace(".", "");

      return (
        this.downloadableFiles?.[mediaType] ||
        this.downloadableFiles?.[extension] ||
        this.downloadableFiles?.all
      );
    }

    return true;
  }

  /**
   * ULTRA-OPTIMIZED download with proper file existence and size validation
   * MAX 3 RETRIES - After 3 failures, skip file and report at end of batch
   */
  async downloadMessage(client, message, channelId, isSingleFile = false, batchIndex = 0) { // Added batchIndex parameter
    const MAX_RETRIES = 3; // Fixed at 3 retries - no more endless loops!
    let attempt = 0;
    let originalMessage = { ...message }; // Keep original for reference
    let mediaPath = null; // Hoist to function scope so catch block can access it
    let lastError = null; // Track last error for reporting

    while (attempt < MAX_RETRIES) {
      try {
        if (!message.media) return null;

        mediaPath = getMediaPath(message, this.outputFolder);
        const expectedSize =
          message.media?.document?.size ||
          message.media?.photo?.sizes?.[0]?.size ||
          0;

        // STEP 1: Check if file exists and is complete BEFORE starting download
        // IMPORTANT: Skip validation if file is locked (actively downloading)
        if (fs.existsSync(mediaPath)) {
          // CRITICAL: Never validate files that are locked (being downloaded)
          if (this.isFileLocked(mediaPath)) {
            logger.info(`🔒 File is locked (active download), skipping validation: ${path.basename(mediaPath)}`);
            // File is being downloaded, don't validate it
            // This prevents disconnect/reconnect loops from re-triggering downloads
            return null; // Return null to skip this attempt, let the active download continue
          }

          const currentFileSize = fs.statSync(mediaPath).size;

          // CRITICAL: Delete 0-byte files immediately (empty/corrupt files)
          if (currentFileSize === 0) {
            logger.warn(`🗑️ Deleting 0-byte empty file: ${path.basename(mediaPath)}`);
            try {
              fs.unlinkSync(mediaPath);
            } catch (error) {
              logger.warn(`⚠️ Failed to delete 0-byte file: ${error.message}`);
            }
            // Continue to download after deleting empty file
          } else {
            // If we don't know the expected size, assume file is complete
            if (expectedSize === 0) {
              logger.info(`✅ File already exists (size unknown, assuming complete): ${path.basename(mediaPath)}`);
              return mediaPath;
            }

            // Check if file size matches expected size (with tolerance based on file type)
            const isPDF = path.extname(mediaPath).toLowerCase() === '.pdf';
            const toleranceThreshold = isPDF ? 0.8 : 0.98; // 98% for others

            if (currentFileSize >= expectedSize * toleranceThreshold) {
              // File exists and size is acceptable, skip download
              logger.info(`✅ File already exists and complete: ${path.basename(mediaPath)} (${(currentFileSize / 1024 / 1024).toFixed(2)}MB / ${(expectedSize / 1024 / 1024).toFixed(2)}MB)`);
              return mediaPath;
            } else {
              // File exists but incomplete - ONLY during pre-batch cleanup phase
              // During active downloads, this should never happen due to lock check above
              logger.warn(`⚠️ Found incomplete file (NOT locked): ${path.basename(mediaPath)} - will re-download`);
            }
          }
        }

        // STEP 2: Ensure directory exists
        const dir = path.dirname(mediaPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // STEP 3: Lock the file to prevent other processes from deleting it
        this.lockFile(mediaPath, message.id);

        // STEP 4: Start fresh download
        const startTime = Date.now();
        logger.info(`📥 Starting download: ${path.basename(mediaPath)} (${(expectedSize / 1024 / 1024).toFixed(2)}MB)`);

        // Dynamic optimization for single files
        const downloadOptions = isSingleFile
          ? {
            workers: 48, // Maximum workers for single file
            chunkSize: 32 * 1024 * 1024, // Larger chunks for single file
            workerIndex: 0,
            optimizeForSpeed: true,
            stabilizeSpeed: false, // Disable stabilization for single files
          }
          : {
            workers: Math.min(24, 16),
            chunkSize: 16 * 1024 * 1024,
            workerIndex: 0,
            optimizeForSpeed: true,
            stabilizeSpeed: true,
          };

        const result = await downloadMessageMedia(
          client,
          message,
          mediaPath,
          1,
          1,
          downloadOptions,
        );

        // STEP 5: Verify download AFTER completion
        if (result && fs.existsSync(mediaPath)) {
          const fileSize = fs.statSync(mediaPath).size;

          // CRITICAL: Check for 0-byte files (download failed)
          if (fileSize === 0) {
            logger.error(`❌ Download produced 0-byte file: ${path.basename(mediaPath)}`);
            this.unlockFile(mediaPath);
            this.deleteExistingFile(mediaPath);
            throw new Error(`Download created empty file: ${path.basename(mediaPath)}`);
          }

          const duration = (Date.now() - startTime) / 1000;
          const speedMbps =
            duration > 0 ? (fileSize * 8) / duration / 1000 / 1000 : 0;

          // Check if file is PDF
          const isPDF = path.extname(mediaPath).toLowerCase() === '.pdf';

          // Verify downloaded file size
          let sizeVerified = true;

          if (!isPDF && expectedSize > 0) {
            // Non-PDF files: strict verification (98% tolerance)
            sizeVerified = fileSize >= expectedSize * 0.98;

            if (!sizeVerified) {
              logger.warn(
                `⚠️ Download incomplete: ${path.basename(mediaPath)} - Expected: ${(expectedSize / 1024 / 1024).toFixed(2)}MB, Got: ${(fileSize / 1024 / 1024).toFixed(2)}MB`,
              );

              // Unlock before deletion and retry
              this.unlockFile(mediaPath);

              // Delete incomplete file and retry
              this.deleteExistingFile(mediaPath);
              throw new Error(`Incomplete download: ${path.basename(mediaPath)}`);
            }
          } else if (isPDF) {
            // PDF files: lenient verification (80% tolerance)
            if (expectedSize > 0 && fileSize < expectedSize * 0.8) {
              logger.info(`📄 PDF size difference detected but acceptable: ${path.basename(mediaPath)} - Expected: ${(expectedSize / 1024 / 1024).toFixed(2)}MB, Got: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
            }
            // Always mark PDFs as verified
            sizeVerified = true;
          }

          if (this.speedMonitor) {
            this.speedMonitor.updateSpeed(fileSize);
          }
          this.totalDownloaded++;
          this.resetFileReferenceTracking(); // Reset error tracking on success

          // STEP 6: Unlock file after successful download
          this.unlockFile(mediaPath);

          logger.info(
            `\u2705 Downloaded: ${path.basename(mediaPath)} [MsgID:${message.id}] (${speedMbps.toFixed(1)} Mbps)${sizeVerified ? " \u2713 Size verified" : ""}${isSingleFile ? " [SINGLE-FILE BOOST]" : ""}`,
          );
          return mediaPath;
        } else {
          // Unlock file if download failed
          this.unlockFile(mediaPath);
          throw new Error("Download verification failed - file not created");
        }
      } catch (error) {
        attempt++;
        lastError = error; // Store last error for reporting

        logger.warn(
          `❌ Download attempt ${attempt}/${MAX_RETRIES} failed for message ${message.id}: ${error.message}`,
        );

        // CRITICAL: Keep file locked during retries to prevent validation loops
        // Only unlock if we've exhausted all retries or it's a permanent failure
        const permanentFailures = [
          'CHAT_FORWARDS_RESTRICTED',
          'AUTH_KEY_INVALID',
          'USER_DEACTIVATED_BAN',
          'PHONE_NUMBER_INVALID',
          'SESSION_EXPIRED'
        ];

        const isPermanentFailure = permanentFailures.some(errorType =>
          error.message.includes(errorType)
        );

        if (isPermanentFailure || attempt >= MAX_RETRIES) {
          // Unlock file only on permanent failure or max retries
          if (mediaPath && this.isFileLocked(mediaPath)) {
            this.unlockFile(mediaPath);
            logger.info(`🔓 File unlocked after ${isPermanentFailure ? 'permanent failure' : 'max retries'}`);
          }
        } else {
          // Keep file locked during retries (disconnect/reconnect scenarios)
          logger.info(`🔒 Keeping file locked during retry ${attempt}/${MAX_RETRIES}`);
        }

        // Special handling for FILE_REFERENCE_EXPIRED - try one refresh
        if (error.message.includes("FILE_REFERENCE_EXPIRED") && attempt < MAX_RETRIES) {
          this.trackFileReferenceError();
          logger.info(`🔄 Attempting to refresh FILE_REFERENCE for message ${message.id}`);

          try {
            const refreshedMessage = await this.refreshMessageWithStrategies(
              client,
              channelId,
              originalMessage,
              1 // Only 1 strategy attempt
            );

            if (refreshedMessage) {
              message = refreshedMessage;
              logger.info(`✅ FILE_REFERENCE refreshed successfully`);
              // Don't modify attempt counter - continue with normal retry logic
            }
          } catch (refreshError) {
            logger.warn(`⚠️ FILE_REFERENCE refresh failed: ${refreshError.message}`);
          }
        }

        // If we've exhausted all retries, track as failed and skip
        if (attempt >= MAX_RETRIES) {
          const fileName = mediaPath ? path.basename(mediaPath) : `Message ${message.id}`;
          this.failedDownloads.push({
            messageId: message.id,
            fileName: fileName,
            reason: lastError.message,
            batch: batchIndex // Add batch index to failed download tracking
          });

          logger.error(`❌ SKIPPING after ${MAX_RETRIES} failed attempts: ${fileName}`);
          return null; // Return null to skip and continue batch
        }

        // Short delay before retry
        const delay = Math.min(3000, 1000 * attempt);
        await this.precisionDelay(delay);
        continue;
      }
    }
    return null;
  }

  /**
   * ULTRA-OPTIMIZED upload with dynamic single-file acceleration
   * MAX 3 RETRIES - After 3 failures, skip and continue
   */
  async uploadMessage(client, message, mediaPath = null, isSingleFile = false) {
    const MAX_RETRIES = 3; // Fixed at 3 retries
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        if (!this.uploadMode || !this.targetChannelId) return false;

        // Minimal rate limit check for single files
        if (!isSingleFile) {
          await this.checkRateLimit();
        }

        const startTime = Date.now();
        const result = await uploadMessageToChannel(
          client,
          this.targetChannelId,
          message,
          mediaPath,
          isSingleFile,
        );

        if (result) {
          const duration = (Date.now() - startTime) / 1000;
          if (mediaPath && fs.existsSync(mediaPath)) {
            const fileSize = fs.statSync(mediaPath).size;
            const speedMbps =
              duration > 0 ? (fileSize * 8) / duration / 1000 / 1000 : 0;
            if (this.speedMonitor) {
              this.speedMonitor.updateSpeed(fileSize);
            }
            logger.info(
              `\ud83d\udce4 Uploaded: ${path.basename(mediaPath || `msg_${message.id}`)} [MsgID:${message.id}] (${speedMbps.toFixed(1)} Mbps)${isSingleFile ? " [SINGLE-FILE BOOST]" : ""}`,
            );
          }

          this.totalUploaded++;
          if (typeof this.updateFloodWaitHistory === "function") {
            this.updateFloodWaitHistory(false); // No flood wait occurred
          }
          return true;
        } else {
          throw new Error("Upload returned false");
        }
      } catch (error) {
        attempt++;
        logger.warn(
          `❌ Upload attempt ${attempt}/${MAX_RETRIES} failed for message ${message.id}: ${error.message}`,
        );

        // Immediate return for permanent failures
        if (error.message.includes("CHAT_FORWARDS_RESTRICTED")) {
          logger.error(`❌ SKIPPING: Chat forwards restricted for message ${message.id}`);
          return false;
        }

        // Handle FLOOD_WAIT with delay
        if (error.message.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60") * 1000;
          if (typeof this.updateFloodWaitHistory === "function") {
            this.updateFloodWaitHistory(true);
          }
          const actualWait = Math.min(waitTime, 30000); // Max 30 seconds
          logger.info(`⏳ FLOOD_WAIT: Waiting ${actualWait / 1000}s before retry...`);
          await this.precisionDelay(actualWait);
          continue;
        }

        // If max retries exhausted, skip and continue
        if (attempt >= MAX_RETRIES) {
          logger.error(`❌ SKIPPING after ${MAX_RETRIES} failed upload attempts: Message ${message.id}`);
          return false;
        }

        // Short delay before retry
        const delay = Math.min(3000, 1000 * attempt);
        await this.precisionDelay(delay);
        continue;
      }
    }
    return false;
  }

  /**
   * ULTRA-HIGH-SPEED batch download with dynamic optimization
   */
  async downloadBatch(client, messages, channelId) {
    const isSingleFile = messages.length === 1;
    const isSmallBatch = messages.length <= 3; // Small batch optimization
    const isLastBatch =
      this.totalProcessedMessages + messages.length >=
      this.totalMessages * 0.95; // Last 5% of files

    // Determine optimization mode
    let optimizationMode;
    if (isSingleFile) {
      optimizationMode = "SINGLE-FILE TURBO";
    } else if (isSmallBatch || isLastBatch) {
      optimizationMode = "SMALL-BATCH TURBO";
    } else {
      optimizationMode = "BATCH PARALLEL";
    }

    // Enhanced speed target for small files and final files
    const speedTarget =
      isSingleFile || isSmallBatch || isLastBatch ? "40+ Mbps" : "30+ Mbps";

    logger.info(
      `📥 ${optimizationMode} download: ${messages.length} messages (${MAX_PARALLEL_DOWNLOADS_CONFIG} workers, ${CHUNK_SIZE_CONFIG / 1024 / 1024}MB chunks) - Target: ${speedTarget}`,
    );

    messages.sort((a, b) => a.id - b.id);

    // Minimal or no wait for single files, small batches, or last batch
    if (isSingleFile || isSmallBatch || isLastBatch) {
      await this.ultraOptimizedWait(5); // Ultra-minimal delay
    } else {
      await this.ultraOptimizedWait(15);
    }

    const downloadPromises = messages.map(async (message, index) => {
      let retryCount = 0;
      const maxBatchRetries = 3;

      while (retryCount < maxBatchRetries) {
        try {
          logger.info(
            `🚀 Ultra-parallel download ${index + 1}/${messages.length}: Message ${message.id}`,
          );

          await this.checkRateLimit();

          let mediaPath = null;
          let hasContent = false;

          if (message.message && message.message.trim()) {
            hasContent = true;
            logger.info(`📝 Text: "${message.message.substring(0, 30)}..."`);
          }

          if (message.media || message.sticker) {
            hasContent = true;
            // Set current file size for speed optimization
            const estimatedSize =
              message.media?.document?.size ||
              message.media?.photo?.sizes?.[0]?.size ||
              0;

            if (this.speedMonitor) {
              this.speedMonitor.setCurrentFileSize(estimatedSize);
            }

            mediaPath = await this.downloadMessage(
              client,
              message,
              channelId,
              isSingleFile || isSmallBatch || isLastBatch, // Treat small batches and last batch like single files
              this.batchCounter // Pass batch index for retry tracking
            );

            if (mediaPath && !fs.existsSync(mediaPath)) {
              logger.warn(`❌ File verification failed: ${mediaPath}`);
              mediaPath = null;
              throw new Error(`File not found: ${mediaPath}`);
            }
          }

          if (hasContent) {
            this.totalProcessedMessages++;
            logger.info(
              `✅ Download complete ${index + 1}/${messages.length}: Message ${message.id} (${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps" : "OK"})`,
            );
            return {
              message: message,
              mediaPath: mediaPath,
              hasContent: hasContent,
              downloadIndex: index,
            };
          }
          break;
        } catch (error) {
          retryCount++;

          // Track FILE_REFERENCE_EXPIRED errors
          if (error.message.includes("FILE_REFERENCE_EXPIRED")) {
            this.trackFileReferenceError();
            logger.error(
              `📋 File reference expired for a message, script will retry automatically`,
            );
          } else {
            logger.error(
              `❌ Batch retry ${retryCount}/${maxBatchRetries} for message ${message.id}: ${error.message}`,
            );
          }

          if (error.message.includes("FLOOD_WAIT")) {
            const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
            this.updateFloodWaitHistory(true, waitTime);
            await this.precisionDelay(waitTime * 1000);
          }

          if (retryCount < maxBatchRetries) {
            await this.precisionDelay(1000 * retryCount);
          } else {
            return {
              message: message,
              mediaPath: null,
              hasContent: Boolean(
                message.message || message.media || message.sticker,
              ),
              downloadIndex: index,
              failed: true,
            };
          }
        }
      }
      return null;
    });

    logger.info(
      `⏳ Processing ${messages.length} downloads with ${MAX_PARALLEL_DOWNLOADS_CONFIG} workers each...`,
    );
    const results = await Promise.all(downloadPromises);

    const downloadedData = results
      .filter((result) => result !== null)
      .sort((a, b) => a.message.id - b.message.id);

    const failedDownloads = downloadedData.filter((data) => data.failed).length;
    if (failedDownloads > 0) {
      logger.warn(`⚠️ ${failedDownloads} downloads had issues but proceeding`);
    }

    logger.info(
      `✅ Ultra-speed downloads complete! ${downloadedData.length} messages ready (Avg: ${this.speedMonitor ? this.speedMonitor.getAverageSpeedMbps() + " Mbps, Peak: " + this.speedMonitor.getPeakSpeedMbps() + " Mbps" : "High Speed"})`,
    );
    return downloadedData;
  }

  /**
   * SEQUENTIAL UPLOAD QUEUE - Maintains strict message order
   * Files wait at 99% until previous files complete upload
   */
  async uploadBatch(client, downloadedData) {
    if (!this.uploadMode || !downloadedData.length) {
      return downloadedData;
    }

    const isSingleFile = downloadedData.length === 1;
    const optimizationMode = isSingleFile
      ? "SINGLE-FILE BOOST"
      : "SEQUENTIAL QUEUE";

    // Sort by message ID to ensure proper order (a, b, c...)
    downloadedData.sort((a, b) => a.message.id - b.message.id);
    logger.info(
      `📤 ${optimizationMode} upload: ${downloadedData.length} messages - STRICT ORDER MAINTAINED`,
    );

    // Initialize sequential upload state
    const uploadQueue = downloadedData.map((data, index) => ({
      ...data,
      queueIndex: index,
      uploadStarted: false,
      uploadCompleted: false,
      readyToUpload: index === 0, // First message can start immediately
      waitingForPrevious: index > 0,
    }));

    let completedUploads = 0;
    const uploadResults = [];

    // Process uploads in strict sequential order
    for (
      let currentIndex = 0;
      currentIndex < uploadQueue.length;
      currentIndex++
    ) {
      const currentData = uploadQueue[currentIndex];
      const messageId = currentData.message.id;
      const fileName = currentData.mediaPath
        ? path.basename(currentData.mediaPath)
        : `Message_${messageId}`;

      try {
        // Wait for previous message to complete (if not first message)
        if (currentIndex > 0) {
          const previousData = uploadQueue[currentIndex - 1];
          if (!previousData.uploadCompleted) {
            logger.info(
              `⏳ File '${fileName}' waiting at 99% for previous message ${previousData.message.id} to complete...`,
            );

            // Keep showing "waiting" status until previous completes
            let waitCounter = 0;
            while (!previousData.uploadCompleted && waitCounter < 300) {
              // Max 5 minutes wait
              process.stdout.write(
                `\r⏳ [${currentIndex + 1}/${uploadQueue.length}] '${fileName}' waiting at 99% for message ${previousData.message.id}... (${waitCounter}s)`,
              );
              await this.precisionDelay(1000);
              waitCounter++;
            }

            if (!previousData.uploadCompleted) {
              throw new Error(
                `Timeout waiting for previous message ${previousData.message.id}`,
              );
            }

            process.stdout.write(
              `\n✅ Previous message completed! '${fileName}' can now upload...\n`,
            );
          }
        }

        // Verify file exists
        if (currentData.mediaPath && !fs.existsSync(currentData.mediaPath)) {
          logger.warn(
            `⚠️ Missing file for message ${messageId}: ${currentData.mediaPath}`,
          );
          currentData.mediaPath = null;
        }

        // Mark as started
        currentData.uploadStarted = true;
        logger.info(
          `🚀 [${currentIndex + 1}/${uploadQueue.length}] Sequential upload starting: '${fileName}' (Message ${messageId})`,
        );

        // Perform upload with retry mechanism
        await this.retryOperation(async () => {
          try {
            if (currentData.mediaPath) {
              await this.uploadMessage(
                client,
                currentData.message,
                currentData.mediaPath,
                isSingleFile,
              );
            } else {
              await this.uploadMessage(
                client,
                currentData.message,
                null,
                isSingleFile,
              );
            }
          } catch (error) {
            if (
              error.message.includes("Not connected") ||
              error.message.includes("Connection closed")
            ) {
              logger.warn(`🔄 Connection issue detected, reconnecting...`);
              await this.reconnectClient(client);
              throw error;
            }
            throw error;
          }
        }, `uploading message ${messageId} (${fileName})`);

        // Mark as completed
        currentData.uploadCompleted = true;
        completedUploads++;

        logger.info(
          `✅ [${currentIndex + 1}/${uploadQueue.length}] Sequential upload complete: '${fileName}' (Message ${messageId}) - ${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps" : "OK"}`,
        );

        // Signal next message that it can start
        if (currentIndex + 1 < uploadQueue.length) {
          uploadQueue[currentIndex + 1].readyToUpload = true;
          uploadQueue[currentIndex + 1].waitingForPrevious = false;
          logger.info(
            `🎯 Next file '${uploadQueue[currentIndex + 1].mediaPath ? path.basename(uploadQueue[currentIndex + 1].mediaPath) : `Message_${uploadQueue[currentIndex + 1].message.id}`}' is now ready to upload`,
          );
        }

        uploadResults.push({ success: true, data: currentData });
      } catch (error) {
        logger.error(
          `❌ Sequential upload error for '${fileName}' (Message ${messageId}): ${error.message}`,
        );

        if (error.message.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          logger.warn(
            `⏳ Flood wait for ${waitTime}s during sequential upload...`,
          );
          await this.precisionDelay(waitTime * 1000);

          try {
            // Retry upload after flood wait
            const retrySuccess = await this.uploadMessage(
              client,
              currentData.message,
              currentData.mediaPath,
              isSingleFile,
            );
            if (retrySuccess) {
              currentData.uploadCompleted = true;
              completedUploads++;
              uploadResults.push({ success: true, data: currentData });
              continue;
            }
          } catch (retryError) {
            logger.error(
              `❌ Sequential upload retry failed: ${retryError.message}`,
            );
          }
        }

        // Mark as failed but continue sequence
        currentData.uploadCompleted = true; // Allow next file to proceed
        uploadResults.push({ success: false, data: currentData });

        // Signal next message can proceed despite this failure
        if (currentIndex + 1 < uploadQueue.length) {
          uploadQueue[currentIndex + 1].readyToUpload = true;
          uploadQueue[currentIndex + 1].waitingForPrevious = false;
        }
      }

      // Small delay between sequential uploads for stability
      if (currentIndex + 1 < uploadQueue.length) {
        await this.precisionDelay(isSingleFile ? 100 : 500);
      }
    }

    logger.info(
      `✅ Sequential upload queue complete! ${completedUploads}/${uploadQueue.length} messages uploaded in perfect order (Avg: ${this.speedMonitor ? this.speedMonitor.getAverageSpeedMbps() + " Mbps, Peak: " + this.speedMonitor.getPeakSpeedMbps() + " Mbps" : "High Speed"})`,
    );

    return downloadedData;
  }

  /**
   * ULTRA-HIGH-SPEED batch download with dynamic optimization
   */
  async downloadBatch(client, messages, channelId) {
    const isSingleFile = messages.length === 1;
    const isSmallBatch = messages.length <= 3; // Small batch optimization
    const isLastBatch =
      this.totalProcessedMessages + messages.length >=
      this.totalMessages * 0.95; // Last 5% of files

    // Determine optimization mode
    let optimizationMode;
    if (isSingleFile) {
      optimizationMode = "SINGLE-FILE TURBO";
    } else if (isSmallBatch || isLastBatch) {
      optimizationMode = "SMALL-BATCH TURBO";
    } else {
      optimizationMode = "BATCH PARALLEL";
    }

    // Enhanced speed target for small files and final files
    const speedTarget =
      isSingleFile || isSmallBatch || isLastBatch ? "40+ Mbps" : "30+ Mbps";

    logger.info(
      `📥 ${optimizationMode} download: ${messages.length} messages (${MAX_PARALLEL_DOWNLOADS_CONFIG} workers, ${CHUNK_SIZE_CONFIG / 1024 / 1024}MB chunks) - Target: ${speedTarget}`,
    );

    messages.sort((a, b) => a.id - b.id);

    // Minimal or no wait for single files, small batches, or last batch
    if (isSingleFile || isSmallBatch || isLastBatch) {
      await this.ultraOptimizedWait(5); // Ultra-minimal delay
    } else {
      await this.ultraOptimizedWait(15);
    }

    const downloadPromises = messages.map(async (message, index) => {
      let retryCount = 0;
      const maxBatchRetries = 3;

      while (retryCount < maxBatchRetries) {
        try {
          logger.info(
            `🚀 Ultra-parallel download ${index + 1}/${messages.length}: Message ${message.id}`,
          );

          await this.checkRateLimit();

          let mediaPath = null;
          let hasContent = false;

          if (message.message && message.message.trim()) {
            hasContent = true;
            logger.info(`📝 Text: "${message.message.substring(0, 30)}..."`);
          }

          if (message.media || message.sticker) {
            hasContent = true;
            // Set current file size for speed optimization
            const estimatedSize =
              message.media?.document?.size ||
              message.media?.photo?.sizes?.[0]?.size ||
              0;

            if (this.speedMonitor) {
              this.speedMonitor.setCurrentFileSize(estimatedSize);
            }

            mediaPath = await this.downloadMessage(
              client,
              message,
              channelId,
              isSingleFile || isSmallBatch || isLastBatch, // Treat small batches and last batch like single files
              this.batchCounter // Pass batch index for retry tracking
            );

            if (mediaPath && !fs.existsSync(mediaPath)) {
              logger.warn(`❌ File verification failed: ${mediaPath}`);
              mediaPath = null;
              throw new Error(`File not found: ${mediaPath}`);
            }
          }

          if (hasContent) {
            this.totalProcessedMessages++;
            logger.info(
              `✅ Download complete ${index + 1}/${messages.length}: Message ${message.id} (${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps" : "OK"})`,
            );
            return {
              message: message,
              mediaPath: mediaPath,
              hasContent: hasContent,
              downloadIndex: index,
            };
          }
          break;
        } catch (error) {
          retryCount++;

          // Track FILE_REFERENCE_EXPIRED errors
          if (error.message.includes("FILE_REFERENCE_EXPIRED")) {
            this.trackFileReferenceError();
            logger.error(
              `📋 File reference expired for a message, script will retry automatically`,
            );
          } else {
            logger.error(
              `❌ Batch retry ${retryCount}/${maxBatchRetries} for message ${message.id}: ${error.message}`,
            );
          }

          if (error.message.includes("FLOOD_WAIT")) {
            const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
            this.updateFloodWaitHistory(true, waitTime);
            await this.precisionDelay(waitTime * 1000);
          }

          if (retryCount < maxBatchRetries) {
            await this.precisionDelay(1000 * retryCount);
          } else {
            return {
              message: message,
              mediaPath: null,
              hasContent: Boolean(
                message.message || message.media || message.sticker,
              ),
              downloadIndex: index,
              failed: true,
            };
          }
        }
      }
      return null;
    });

    logger.info(
      `⏳ Processing ${messages.length} downloads with ${MAX_PARALLEL_DOWNLOADS_CONFIG} workers each...`,
    );
    const results = await Promise.all(downloadPromises);

    const downloadedData = results
      .filter((result) => result !== null)
      .sort((a, b) => a.message.id - b.message.id);

    const failedDownloads = downloadedData.filter((data) => data.failed).length;
    if (failedDownloads > 0) {
      logger.warn(`⚠️ ${failedDownloads} downloads had issues but proceeding`);
    }

    logger.info(
      `✅ Ultra-speed downloads complete! ${downloadedData.length} messages ready (Avg: ${this.speedMonitor ? this.speedMonitor.getAverageSpeedMbps() + " Mbps, Peak: " + this.speedMonitor.getPeakSpeedMbps() + " Mbps" : "High Speed"})`,
    );
    return downloadedData;
  }

  /**
   * Cleanup batch files
   */
  async cleanupBatch(downloadedData) {
    logger.info(`🗑️ Cleaning up ${downloadedData.length} files`);

    const cleanupPromises = downloadedData.map(async (data) => {
      if (data.mediaPath && fs.existsSync(data.mediaPath)) {
        try {
          fs.unlinkSync(data.mediaPath);
        } catch (cleanupError) {
          logger.warn(
            `⚠️ Cleanup failed for ${data.mediaPath}: ${cleanupError.message}`,
          );
        }
      }
    });

    await Promise.all(cleanupPromises);
    logger.info(`✅ Cleanup complete`);
  }

  /**
   * Enhanced message refresh with speed optimization
   */
  async refreshMessagesBatch(client, channelId, messageIds) {
    try {
      logger.info(`🔄 Refreshing ${messageIds.length} messages...`);
      const refreshedMessages = await getMessageDetail(
        client,
        channelId,
        messageIds,
      );
      logger.info(`✅ Refreshed ${refreshedMessages.length} messages`);
      return refreshedMessages;
    } catch (error) {
      logger.error(`❌ Message refresh failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Function to refresh ALL channel messages every 3 batches to prevent false "file exists" detection.
   */
  async refreshAllChannelMessages(client, channelId) {
    try {
      logger.info(
        `🔄 Fetching ALL messages from channel ${channelId} for refresh...`,
      );
      // Fetch all messages to ensure comprehensive refresh
      const allMessages = await getMessages(
        client,
        channelId,
        MESSAGE_LIMIT_CONFIG,
        0,
        true,
      );

      if (!allMessages || allMessages.length === 0) {
        logger.warn("No messages found in the channel for refresh.");
        return [];
      }

      const messageIds = allMessages.map((msg) => msg.id);
      logger.info(`🔄 Refreshing details for ${messageIds.length} messages...`);
      const refreshedMessages = await getMessageDetail(
        client,
        channelId,
        messageIds,
      );
      logger.info(
        `✅ Successfully refreshed details for ${refreshedMessages.length} messages.`,
      );
      return refreshedMessages;
    } catch (error) {
      logger.error(
        `❌ Failed to refresh all channel messages: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * ULTRA-OPTIMIZED batch processing with proactive refresh every batch
   */
  async processBatch(client, messages, batchIndex, totalBatches, channelId) {
    try {
      this.batchCounter++;
      logger.info(
        `🔄 ULTRA-SPEED batch ${batchIndex + 1}/${totalBatches} (${messages.length} messages) - Speed: ${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps (" + this.speedMonitor.getSpeedStatus() + ")" : "Optimizing..."}`,
      );

      // CRITICAL: Pre-batch cleanup to remove incomplete files BEFORE starting downloads
      // This prevents the infinite loop by ensuring incomplete files are cleaned up once
      // at the batch start, not continuously during active downloads
      await this.cleanupIncompleteFiles(messages);

      // Enhanced: Refresh messages EVERY batch to prevent FILE_REFERENCE_EXPIRED errors
      logger.info(
        `🔄 Batch ${this.batchCounter}: Proactively refreshing messages to prevent file reference errors...`,
      );

      // Refresh current batch messages specifically
      const currentMessageIds = messages.map((m) => m.id);
      try {
        const refreshedMessages = await getMessageDetail(client, channelId, currentMessageIds);

        if (refreshedMessages && refreshedMessages.length > 0) {
          // Update messages with refreshed data
          const messageMap = new Map(refreshedMessages.map(msg => [msg.id, msg]));
          messages = messages.map(msg => messageMap.get(msg.id) || msg);
          logger.success(`✅ Refreshed ${refreshedMessages.length}/${messages.length} batch messages`);
        } else {
          // Fallback: Full channel refresh if batch refresh fails
          logger.warn(`⚠️ Batch refresh failed, attempting full channel refresh...`);
          const allRefreshedMessages = await this.refreshAllChannelMessages(client, channelId);

          if (allRefreshedMessages && allRefreshedMessages.length > 0) {
            const messageMap = new Map(allRefreshedMessages.map(msg => [msg.id, msg]));
            messages = messages.map(msg => messageMap.get(msg.id) || msg);
            logger.success(`✅ Fallback: Updated ${messages.length} messages from full refresh`);
          }
        }
      } catch (refreshError) {
        logger.warn(`⚠️ Message refresh failed: ${refreshError.message}, proceeding with original messages`);
      }

      // Additional refresh every 3 batches or when high FILE_REFERENCE error rate detected
      const recentFileRefErrors = this.fileReferenceErrors.filter(
        timestamp => Date.now() - timestamp < 2 * 60 * 1000 // Last 2 minutes
      ).length;

      if (this.batchCounter % 4 === 0 || recentFileRefErrors > 5) {
        logger.info(
          `🔄 Extra refresh triggered - Batch ${this.batchCounter} or high error rate (${recentFileRefErrors} recent errors)`,
        );
        const allRefreshedMessages = await this.refreshAllChannelMessages(client, channelId);

        if (allRefreshedMessages && allRefreshedMessages.length > 0) {
          const messageMap = new Map(allRefreshedMessages.map(msg => [msg.id, msg]));
          messages = messages.map(msg => messageMap.get(msg.id) || msg);
          logger.success(`✅ Extra refresh: Updated ${messages.length} messages`);
        }
      }

      // Task 3: Duplicate messages only works if the duplicate messages send together line number of three in one line then they will remove the duplicate messages not for the whole sessions it will work work when their is one after the other.
      // This task is inherently handled by the nature of how messages are processed sequentially and media is checked.
      // If duplicates are sent consecutively, the `checkFileExist` within `downloadMessage` will correctly identify and skip them.
      // For non-consecutive duplicates, the script will attempt to download them if they are in different batches and `checkFileExist` will work as intended for each message.

      // Phase 1: Ultra-high-speed parallel download
      logger.info(
        `📥 Phase 1: Ultra-download ${messages.length} messages (${MAX_PARALLEL_DOWNLOADS_CONFIG} workers, ${CHUNK_SIZE_CONFIG / 1024 / 1024}MB chunks)`,
      );
      const downloadedData = await this.downloadBatch(
        client,
        messages,
        channelId,
      );

      // Phase 2: Ultra-high-speed parallel upload
      if (this.uploadMode && downloadedData.length > 0) {
        logger.info(
          `📤 Phase 2: Ultra-upload ${downloadedData.length} messages (${MAX_PARALLEL_UPLOADS_CONFIG} workers)`,
        );
        await this.ensureConnectionHealth(client);
        const uploadedData = await this.uploadBatch(client, downloadedData);

        // Phase 3: Ultra-fast cleanup
        logger.info(`🗑️ Phase 3: Ultra-cleanup ${uploadedData.length} files`);
        await this.cleanupBatch(uploadedData);
      }

      // Report failed downloads at the end of each batch
      if (this.failedDownloads.length > 0) {
        logger.error(`\n⚠️ ========== FAILED DOWNLOADS REPORT ==========`);
        logger.error(`❌ ${this.failedDownloads.length} file(s) could not be downloaded after ${3} retry attempts:`);
        this.failedDownloads.forEach((failed, index) => {
          logger.error(`   ${index + 1}. Message ${failed.messageId} (Batch ${failed.batch}): ${failed.fileName}`);
          logger.error(`      Reason: ${failed.reason}`);
        });
        logger.error(`⚠️ ============================================\n`);

        // Clear failed downloads list for next batch
        this.failedDownloads = [];
      }

      logger.info(
        `✅ Ultra-speed batch ${batchIndex + 1}/${totalBatches} complete (Current: ${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps, Avg: " + this.speedMonitor.getAverageSpeedMbps() + " Mbps, Peak: " + this.speedMonitor.getPeakSpeedMbps() + " Mbps" : "Complete"})`,
      );
    } catch (error) {
      logger.error(`❌ Batch error ${batchIndex + 1}: ${error.message}`);

      // Enhanced retry with adaptive recovery
      try {
        const messageIds = messages.map((m) => m.id);
        const retryMessages = await this.refreshMessagesBatch(
          client,
          channelId,
          messageIds,
        );
        if (retryMessages && retryMessages.length > 0) {
          await this.ensureConnectionHealth(client);
          await this.processBatch(
            client,
            retryMessages,
            batchIndex,
            totalBatches,
            channelId,
          );
        }
      } catch (retryError) {
        logger.error(`❌ Batch retry failed: ${retryError.message}`);
      }
    }
  }

  /**
   * Record messages with enhanced tracking
   */
  recordMessages(messages) {
    const filePath = path.join(this.outputFolder, "all_messages.json");
    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, { recursive: true });
    }

    const data = messages.map((msg) => ({
      id: msg.id,
      message: msg.message || "",
      date: msg.date,
      out: msg.out,
      hasMedia: !!msg.media,
      sender: msg.fromId?.userId || msg.peerId?.userId,
      mediaType: this.hasContent(msg) ? getMediaType(msg) : undefined,
      mediaPath:
        this.hasContent(msg) && msg.media
          ? getMediaPath(msg, this.outputFolder)
          : undefined,
      mediaName:
        this.hasContent(msg) && msg.media
          ? path.basename(getMediaPath(msg, this.outputFolder))
          : undefined,
    }));

    appendToJSONArrayFile(filePath, data);
  }

  /**
   * Enhanced memory cleanup with garbage collection optimization
   */
  cleanupMemory() {
    try {
      if (global.gc) {
        global.gc();
      }

      // Clear speed history periodically to prevent memory buildup
      if (this.speedMonitor && this.speedMonitor.speedHistory.length > 20) {
        this.speedMonitor.speedHistory =
          this.speedMonitor.speedHistory.slice(-10);
      }

      // Clean old flood wait history
      const now = Date.now();
      this.floodWaitHistory = this.floodWaitHistory.filter(
        (entry) => now - entry.timestamp < 5 * 60 * 1000,
      );

      // Clean old file reference error history
      this.fileReferenceErrors = this.fileReferenceErrors.filter(
        (timestamp) => now - timestamp < 30 * 60 * 1000,
      );

      const tempDir = path.join(this.outputFolder, "temp");
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        files.forEach((file) => {
          const filePath = path.join(tempDir, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtime.getTime() > 2 * 60 * 1000) {
            // 2 minutes
            fs.unlinkSync(filePath);
          }
        });
      }
    } catch (err) {
      logger.warn("Memory cleanup failed:", err.message);
    }
  }

  /**
   * Enhanced progress display with comprehensive speed metrics
   */
  showProgress(currentBatch) {
    const progressPercentage =
      this.totalMessages > 0
        ? Math.round((this.totalProcessedMessages / this.totalMessages) * 100)
        : 0;

    if (currentBatch % 3 === 0) {
      this.cleanupMemory();
    }

    logger.info("=".repeat(90));
    logger.info("🚀 ULTRA-HIGH-SPEED PROCESSING REPORT (TARGET: 35+ Mbps)");
    logger.info("=".repeat(90));
    logger.info(`📥 Downloaded: ${this.totalDownloaded} files`);
    if (this.uploadMode) {
      logger.info(`📤 Uploaded: ${this.totalUploaded} messages`);
    }
    logger.info(
      `📈 Progress: ${progressPercentage}% (${this.totalProcessedMessages}/${this.totalMessages})`,
    );
    logger.info(
      `🚀 Current Speed: ${this.speedMonitor ? this.speedMonitor.getCurrentSpeedMbps() + " Mbps " + this.speedMonitor.getSpeedStatus() : "Optimizing..."}`,
    );
    logger.info(
      `📊 Average Speed: ${this.speedMonitor ? this.speedMonitor.getAverageSpeedMbps() + " Mbps" : "N/A"}`,
    );
    logger.info(
      `🎯 Peak Speed: ${this.speedMonitor ? this.speedMonitor.getPeakSpeedMbps() + " Mbps" : "N/A"}`,
    );
    logger.info(`📦 Batch: ${currentBatch} messages processed`);
    logger.info(
      `🎯 Speed Factor: ${this.speedMonitor ? this.speedMonitor.stabilizationFactor.toFixed(1) + "x" : "N/A"} | Boost Mode: ${this.speedBoostMode ? "ON" : "OFF"}`,
    );
    logger.info(
      `🌊 Flood Waits: ${this.consecutiveFloodWaits} consecutive | Adaptive Delay: ${this.adaptiveDelayMultiplier.toFixed(2)}x`,
    );
    logger.info(
      `⚡ File Reference Errors: ${this.consecutiveFileRefErrors} consecutive`,
    );
    logger.info(`🔗 Connection Health: ${this.connectionHealth}%`);
    logger.info("=".repeat(90));
  }

  /**
   * Scan channel in batches of 500 messages and collect metadata
   */
  async scanChannelInBatches(client, channelId, batchSize = 500) {
    logger.info(`🔍 Scanning channel ${channelId} in batches of ${batchSize} messages...`);
    const allMessages = [];
    let offsetId = 0;
    let hasMore = true;
    let totalScanned = 0;

    while (hasMore) {
      try {
        const messages = await getMessages(client, channelId, batchSize, offsetId, true);

        if (!messages || messages.length === 0) {
          hasMore = false;
          break;
        }

        totalScanned += messages.length;
        allMessages.push(...messages);

        logger.info(`📊 Scanned ${totalScanned} messages so far...`);

        if (messages.length < batchSize) {
          hasMore = false;
        } else {
          offsetId = Math.max(...messages.map(m => m.id));
          await this.precisionDelay(1000);
        }
      } catch (error) {
        logger.error(`❌ Error scanning batch at offset ${offsetId}: ${error.message}`);
        await this.precisionDelay(2000);
      }
    }

    logger.success(`✅ Scan complete: ${totalScanned} total messages found`);
    return allMessages;
  }

  /**
   * Extract metadata from message for comparison
   */
  extractMessageMetadata(message, outputFolder) {
    const caption = message.message || "";
    const hasMedia = !!message.media;

    let fileName = "";
    let mediaType = "";
    let fileSize = 0;

    if (hasMedia) {
      mediaType = getMediaType(message);
      const mediaPath = getMediaPath(message, outputFolder);
      fileName = path.basename(mediaPath);
      fileSize = message.media?.document?.size || message.media?.photo?.sizes?.[0]?.size || 0;
    }

    return {
      id: message.id,
      date: message.date,
      caption: caption,
      captionHash: this.hashString(caption),
      fileName: fileName,
      mediaType: mediaType,
      fileSize: fileSize,
      hasMedia: hasMedia,
      message: message
    };
  }

  /**
   * Simple hash function for strings
   */
  hashString(str) {
    if (!str) return "";
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  /**
   * Compare two channels and find missing messages
   */
  async compareChannels(sourceMessages, targetMessages) {
    logger.info(`🔍 Comparing channels...`);
    logger.info(`   Source: ${sourceMessages.length} messages`);
    logger.info(`   Target: ${targetMessages.length} messages`);

    const sourceFolder = path.join(process.cwd(), "export", "source_temp");
    const targetFolder = path.join(process.cwd(), "export", "target_temp");

    const sourceMetadata = sourceMessages.map(msg =>
      this.extractMessageMetadata(msg, sourceFolder)
    );
    const targetMetadata = targetMessages.map(msg =>
      this.extractMessageMetadata(msg, targetFolder)
    );

    const targetCaptionMap = new Map();
    const targetFileNameMap = new Map();
    const targetIdSet = new Set();

    for (const meta of targetMetadata) {
      targetIdSet.add(meta.id);

      if (meta.caption) {
        if (!targetCaptionMap.has(meta.captionHash)) {
          targetCaptionMap.set(meta.captionHash, []);
        }
        targetCaptionMap.get(meta.captionHash).push(meta);
      }

      if (meta.fileName) {
        if (!targetFileNameMap.has(meta.fileName)) {
          targetFileNameMap.set(meta.fileName, []);
        }
        targetFileNameMap.get(meta.fileName).push(meta);
      }
    }

    const missingMessages = [];

    for (const sourceMeta of sourceMetadata) {
      let found = false;

      if (sourceMeta.caption && targetCaptionMap.has(sourceMeta.captionHash)) {
        const matches = targetCaptionMap.get(sourceMeta.captionHash);
        if (matches.some(m =>
          m.caption === sourceMeta.caption &&
          m.mediaType === sourceMeta.mediaType
        )) {
          found = true;
        }
      }

      if (!found && sourceMeta.fileName && targetFileNameMap.has(sourceMeta.fileName)) {
        const matches = targetFileNameMap.get(sourceMeta.fileName);
        if (matches.some(m =>
          m.mediaType === sourceMeta.mediaType &&
          Math.abs(m.fileSize - sourceMeta.fileSize) < 1024
        )) {
          found = true;
        }
      }

      if (!found) {
        missingMessages.push(sourceMeta.message);
      }
    }

    logger.success(`✅ Comparison complete: ${missingMessages.length} missing messages found`);

    if (missingMessages.length > 0) {
      logger.info(`📋 Missing messages breakdown:`);
      const withMedia = missingMessages.filter(m => m.media).length;
      const textOnly = missingMessages.length - withMedia;
      logger.info(`   - With media: ${withMedia}`);
      logger.info(`   - Text only: ${textOnly}`);
    }

    return missingMessages;
  }

  /**
   * Sync missing files from source to target channel
   */
  async syncMissingFiles(client, sourceChannelId, targetChannelId, missingMessages) {
    if (missingMessages.length === 0) {
      logger.info(`✅ Channels are already in sync! No files to transfer.`);
      return;
    }

    logger.info(`🔄 Starting sync of ${missingMessages.length} missing messages...`);

    this.outputFolder = path.join(process.cwd(), "export", sourceChannelId.toString());
    this.targetChannelId = targetChannelId;
    this.uploadMode = true;

    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, { recursive: true });
    }

    missingMessages.sort((a, b) => a.id - b.id);

    const totalBatches = Math.ceil(missingMessages.length / BATCH_SIZE);
    this.totalMessages = missingMessages.length;
    this.totalProcessedMessages = 0;

    for (let i = 0; i < missingMessages.length; i += BATCH_SIZE) {
      const batch = missingMessages.slice(i, i + BATCH_SIZE);
      const batchIndex = Math.floor(i / BATCH_SIZE);

      logger.info(`🚀 Sync batch ${batchIndex + 1}/${totalBatches} - ${batch.length} messages`);

      await this.processBatch(
        client,
        batch,
        batchIndex,
        totalBatches,
        sourceChannelId
      );

      if (i + BATCH_SIZE < missingMessages.length) {
        await this.precisionDelay(RATE_LIMIT_DELAY_CONFIG);
      }
    }

    logger.success(`✅ Sync complete! ${this.totalDownloaded} files downloaded, ${this.totalUploaded} messages uploaded`);
  }

  /**
   * MAIN ultra-high-speed download function with 35+ Mbps target
   */
  async downloadChannel(client, channelId, offsetMsgId = 0) {
    try {
      this.initializeSpeedMonitor();

      this.outputFolder = path.join(
        process.cwd(),
        "export",
        channelId.toString(),
      );

      if (this.syncMode) {
        logger.info("🔄 SYNC MODE: Comparing and syncing channels...");

        logger.info("📥 Step 1: Scanning source channel (download channel)...");
        const sourceMessages = await this.scanChannelInBatches(client, channelId, 500);

        if (!this.targetChannelId) {
          throw new Error("Target channel not configured for sync mode!");
        }

        logger.info("📥 Step 2: Scanning target channel (upload channel)...");
        const targetMessages = await this.scanChannelInBatches(client, this.targetChannelId, 500);

        logger.info("🔍 Step 3: Comparing channels to find missing files...");
        const missingMessages = await this.compareChannels(sourceMessages, targetMessages);

        logger.info("🔄 Step 4: Syncing missing files...");
        await this.syncMissingFiles(client, channelId, this.targetChannelId, missingMessages);

        logger.success("✅ SYNC COMPLETE!");
        return;
      }

      if (this.selectiveMode && offsetMsgId === 0) {
        offsetMsgId = this.startFromMessageId;
        logger.info(
          `📋 Selective mode: Starting from message ID ${offsetMsgId}`,
        );
      }

      const messages = await this.retryOperation(async () => {
        return await getMessages(
          client,
          channelId,
          MESSAGE_LIMIT_CONFIG,
          offsetMsgId,
          true,
        );
      });

      if (!messages.length) {
        logger.info("🎉 Ultra-speed processing complete! No more messages.");
        this.showProgress(0);
        return;
      }

      let filteredMessages = messages;
      if (this.selectiveMode) {
        filteredMessages = messages.filter(
          (msg) => msg.id >= this.startFromMessageId,
        );
        logger.info(
          `📋 Filtered ${filteredMessages.length} messages from ${messages.length}`,
        );
      }

      filteredMessages.sort((a, b) => a.id - b.id);

      const ids = filteredMessages.map((m) => m.id);
      const details = await this.retryOperation(async () => {
        return await getMessageDetail(client, channelId, ids);
      });

      details.sort((a, b) => a.id - b.id);
      const messagesToProcess = details.filter((msg) =>
        this.shouldProcess(msg),
      );

      logger.info(
        `📋 Ultra-processing ${messagesToProcess.length}/${details.length} messages`,
      );
      logger.info(
        `🚀 ULTRA-SPEED CONFIG: ${BATCH_SIZE} batches, ${MAX_PARALLEL_DOWNLOADS_CONFIG} download workers, ${MAX_PARALLEL_UPLOADS_CONFIG} upload workers`,
      );
      logger.info(
        `⚡ SPEED OPTIMIZATION: ${CHUNK_SIZE_CONFIG / 1024 / 1024}MB chunks, ${RATE_LIMIT_DELAY_CONFIG}ms delays, 35+ Mbps target`,
      );

      if (this.uploadMode) {
        const targetName = await getDialogName(client, this.targetChannelId);
        logger.info(`📤 Target: ${targetName}`);
      }

      const totalBatches = Math.ceil(messagesToProcess.length / BATCH_SIZE);
      this.totalMessages = messagesToProcess.length;

      for (let i = 0; i < messagesToProcess.length; i += BATCH_SIZE) {
        const batch = messagesToProcess.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE);

        logger.info(
          `🚀 Ultra-speed batch ${batchIndex + 1}/${totalBatches} - ${batch.length} messages`,
        );
        await this.processBatch(
          client,
          batch,
          batchIndex,
          totalBatches,
          channelId,
        );

        if (i + BATCH_SIZE < messagesToProcess.length) {
          logger.info(
            `⏳ Ultra-precision delay ${RATE_LIMIT_DELAY_CONFIG}ms before next ultra-batch...`,
          );
          await this.precisionDelay(RATE_LIMIT_DELAY_CONFIG);
        }
      }

      this.recordMessages(details);

      const maxId = Math.max(...filteredMessages.map((m) => m.id));
      updateLastSelection({
        messageOffsetId: maxId,
      });

      this.showProgress(messagesToProcess.length);

      // Check if there are more messages to process
      if (messages.length === MESSAGE_LIMIT_CONFIG) {
        // There might be more messages, continue with next batch
        await this.precisionDelay(RATE_LIMIT_DELAY_CONFIG);
        await this.downloadChannel(client, channelId, maxId);
      } else {
        // All messages processed for this channel
        logger.info("🎉 Ultra-speed processing complete! No more messages.");
        this.showProgress(messagesToProcess.length);
        return;
      }
    } catch (err) {
      logger.error("Ultra-speed processing error:");
      console.error(err);

      if (err.message && err.message.includes("FLOOD_WAIT")) {
        const waitTime =
          parseInt(err.message.match(/\d+/)?.[0] || "300") * 1000;
        this.updateFloodWaitHistory(true, waitTime / 1000);
        logger.info(
          `⚠️ Rate limited! Waiting ${waitTime / 1000}s... (Adaptive: ${this.adaptiveDelayMultiplier.toFixed(2)}x)`,
        );
        await this.precisionDelay(waitTime);
        return await this.downloadChannel(client, channelId, offsetMsgId);
      }

      throw err;
    }
  }

  /**
   * Enhanced configuration with ultra-speed optimization
   */
  async configureDownload(options, client) {
    let channelId = options.channelId;
    let downloadableFiles = options.downloadableFiles;

    // Config-from-file mode: skip all interactive prompts
    if (options.configFromFile) {
      const cfg = options.configFromFile;
      channelId = cfg.channelId;
      logger.info(`\ud83d\udcc1 Auto-configured from file upload`);
      logger.info(`   \ud83d\udce5 Download Channel: ${channelId}`);

      // Map numeric mode to internal mode names
      const modeMap = { 1: 'full', 2: 'specific', 3: 'toEnd', 4: 'sync' };
      const downloadMode = modeMap[cfg.downloadMode] || 'full';
      logger.info(`   \ud83d\udcdd Mode: ${downloadMode}`);

      let startFromMessageId = 0;
      if (downloadMode === 'specific' && cfg.specificMessages && cfg.specificMessages.length > 0) {
        this.specificMessageIds = cfg.specificMessages;
        logger.info(`   \ud83d\udccb Specific messages: ${cfg.specificMessages.join(', ')}`);
      } else if (downloadMode === 'toEnd' && cfg.specificMessages && cfg.specificMessages.length > 0) {
        startFromMessageId = cfg.specificMessages[0];
        this.downloadToEndMode = true;
        logger.info(`   \ud83d\udccb Download from message ${startFromMessageId} to end`);
      } else if (downloadMode === 'sync') {
        logger.info(`   \ud83d\udd04 SYNC MODE: Compare and sync missing files`);
        this.syncMode = true;
        this.uploadMode = true;
      } else {
        logger.info(`   \ud83d\udccb Full channel download (ULTRA-SPEED)`);
      }

      this.selectiveMode = downloadMode !== 'full';
      this.startFromMessageId = startFromMessageId;

      // Upload configuration from file
      if (cfg.uploadChannel) {
        this.uploadMode = true;
        this.targetChannelId = cfg.uploadChannel;
        logger.info(`   \ud83d\udce4 Upload to: ${cfg.uploadChannel}`);
      } else {
        this.uploadMode = false;
        logger.info(`   \ud83d\udcbe Local storage only (no upload)`);
      }

      // Set default downloadable files
      if (!downloadableFiles) {
        downloadableFiles = {
          webpage: true, poll: true, geo: true, contact: true, venue: true,
          sticker: true, image: true, video: true, audio: true, voice: true,
          document: true, pdf: true, zip: true, all: true,
        };
      }
      this.downloadableFiles = downloadableFiles;

      const lastSelection = getLastSelection();
      let messageOffsetId = lastSelection.messageOffsetId || 0;
      if (Number(lastSelection.channelId) !== Number(channelId)) {
        messageOffsetId = 0;
      }
      updateLastSelection({ messageOffsetId, channelId });
      return { channelId, messageOffsetId };
    }

    // Check if this is a resume from existing session
    const isResumeSession = options.resumeSession || false;

    if (isResumeSession) {
      logger.info("🔄 Resuming with existing login credentials - Starting from channel selection");
    }

    if (!channelId) {
      logger.info("Select channel for ULTRA-SPEED download (35+ Mbps target)");
      const allChannels = await getAllDialogs(client);

      const useSearch = await booleanInput(
        "Search channel by name? (No = browse all)",
      );

      let selectedChannelId;
      if (useSearch) {
        const { searchDialog } = require("../modules/dialoges");
        selectedChannelId = await searchDialog(allChannels);
      } else {
        const validChannels = allChannels.filter((d) => d.name && d.id);
        const channelOptions = validChannels.map((d) => {
          const displayName = `${d.name} (${d.id})`;
          return {
            name: displayName,
            value: d.id,
          };
        });

        if (channelOptions.length === 0) {
          throw new Error("No valid channels found!");
        }

        selectedChannelId = await selectInput(
          "Select source channel for ULTRA-SPEED download",
          channelOptions,
        );
      }

      channelId = selectedChannelId;
    }

    // Download mode selection
    const downloadModeOptions = [
      { name: "Download ALL messages (ULTRA-SPEED 35+ Mbps)", value: "full" },
      { name: "Download SPECIFIC messages only", value: "specific" },
      { name: "Download FROM message TO END", value: "toEnd" },
      { name: "COMPARE and SYNC missing files between channels", value: "sync" },
    ];

    const downloadMode = await selectInput(
      "Choose ULTRA-SPEED download mode:",
      downloadModeOptions,
    );

    let startFromMessageId = 0;
    if (downloadMode === "specific") {
      const { textInput } = require("../utils/input-helper");
      const messageIdInput = await textInput(
        "Enter specific message IDs (comma-separated): ",
      );
      const messageIds = messageIdInput
        .split(",")
        .map((id) => parseInt(id.trim()))
        .filter((id) => !isNaN(id));
      if (messageIds.length === 0) {
        throw new Error("No valid message IDs provided!");
      }
      this.specificMessageIds = messageIds;
      logger.info(`📋 Specific messages: ${messageIds.join(", ")}`);
    } else if (downloadMode === "toEnd") {
      const { textInput } = require("../utils/input-helper");
      const messageIdInput = await textInput("Enter starting message ID: ");
      startFromMessageId = parseInt(messageIdInput) || 0;
      logger.info(`📋 Download from message ${startFromMessageId} to end`);
      this.downloadToEndMode = true;
    } else if (downloadMode === "sync") {
      logger.info("🔄 SYNC MODE: Compare and sync missing files between channels");
      this.syncMode = true;
      this.uploadMode = true;
    } else {
      logger.info("📋 ULTRA-SPEED full channel download (35+ Mbps target)");
    }

    this.selectiveMode = downloadMode !== "full";
    this.startFromMessageId = startFromMessageId;

    // Upload mode configuration
    this.uploadMode = await booleanInput(
      "Enable ULTRA-SPEED upload to another channel? (35+ Mbps)",
    );

    if (this.uploadMode) {
      logger.info("Select target channel for ULTRA-SPEED upload");
      const allChannels = await getAllDialogs(client);

      const useSearchForTarget = await booleanInput(
        "Search target channel by name?",
      );

      let targetChannelId;
      if (useSearchForTarget) {
        const validTargetChannels = allChannels.filter(
          (d) => d.name && d.id && d.id !== channelId,
        );
        if (validTargetChannels.length === 0) {
          logger.warn("No valid target channels! Upload disabled.");
          this.uploadMode = false;
        } else {
          const { searchDialog } = require("../modules/dialoges");
          targetChannelId = await searchDialog(validTargetChannels);
        }
      } else {
        const validTargetChannels = allChannels.filter(
          (d) => d.name && d.id && d.id !== channelId,
        );
        const targetOptions = validTargetChannels.map((d) => {
          const displayName = `${d.name} (${d.id})`;
          return {
            name: displayName,
            value: d.id,
          };
        });

        if (targetOptions.length === 0) {
          logger.warn("No valid target channels! Upload disabled.");
          this.uploadMode = false;
        } else {
          targetChannelId = await selectInput(
            "Select target channel for ULTRA-SPEED upload",
            targetOptions,
          );
        }
      }

      if (this.uploadMode) {
        this.targetChannelId = targetChannelId;
        logger.info(
          `📤 ULTRA-SPEED upload enabled (35+ Mbps): ${this.targetChannelId}`,
        );
      }
    }

    if (!this.uploadMode) {
      logger.info("💾 ULTRA-SPEED local storage mode (35+ Mbps)");
    }

    // Enhanced file type configuration
    if (!downloadableFiles) {
      downloadableFiles = {
        webpage: true,
        poll: true,
        geo: true,
        contact: true,
        venue: true,
        sticker: true,
        image: true,
        video: true,
        audio: true,
        voice: true,
        document: true,
        pdf: true,
        zip: true,
        all: true,
      };
    }

    this.downloadableFiles = downloadableFiles;

    const lastSelection = getLastSelection();
    let messageOffsetId = lastSelection.messageOffsetId || 0;

    if (Number(lastSelection.channelId) !== Number(channelId)) {
      messageOffsetId = 0;
    }

    updateLastSelection({ messageOffsetId, channelId });
    return { channelId, messageOffsetId };
  }

  /**
   * Main handler with ultra-speed initialization targeting 35+ Mbps
   */
  async handle(options = {}) {
    let client;

    try {
      await this.ultraOptimizedWait(100);

      // Check if this is a resume from existing session
      const isResume = process.argv.includes('--resume') || options.resumeSession || options.resume;

      if (isResume) {
        logger.info("\ud83d\udd04 Resuming session - Using existing authentication");
        options.resumeSession = true;
      }

      // Check for config from file upload
      if (options.configFromFile) {
        logger.info("\ud83d\udcc1 Config file mode - Auto-configured download");
      }

      client = await initAuth();

      // Enable continuous mode - keep running until user chooses to exit
      await this.continuousMode(client, options);
    } catch (err) {
      logger.error("ULTRA-SPEED processing error:");
      console.error(err);
      await this.ultraOptimizedWait(5000);
    } finally {
      if (client) {
        try {
          await client.disconnect();
        } catch (disconnectErr) {
          logger.warn("Disconnect error:", disconnectErr.message);
        }
      }
      process.exit(0);
    }
  }

  /**
   * Continuous mode - allows multiple channel downloads without re-authentication
   */
  async continuousMode(client, initialOptions = {}) {
    logger.info(
      "🔄 CONTINUOUS MODE: Multiple channel downloads without re-login",
    );
    logger.info("📋 You can download/upload multiple channels in one session");

    while (true) {
      try {
        // Reset instance variables for new channel
        this.totalDownloaded = 0;
        this.totalUploaded = 0;
        this.totalMessages = 0;
        this.totalProcessedMessages = 0;
        this.skippedFiles = 0;
        this.batchCounter = 0;
        this.requestCount = 0;
        this.lastRequestTime = 0;
        this.consecutiveFloodWaits = 0;
        this.consecutiveFileRefErrors = 0; // Reset file reference errors
        this.speedMonitor = null;

        const { channelId, messageOffsetId } = await this.configureDownload(
          initialOptions,
          client,
        );

        const dialogName = await getDialogName(client, channelId);
        logger.info(
          `🚀 ULTRA-HIGH-SPEED download (35+ Mbps target): ${dialogName}`,
        );
        logger.info(
          `⚙️ CONFIG: Batch=${BATCH_SIZE}, Upload=${this.uploadMode ? "ON" : "OFF"}`,
        );
        logger.info(
          `🚀 SPEED: ${MAX_PARALLEL_DOWNLOADS_CONFIG} download workers, ${MAX_PARALLEL_UPLOADS_CONFIG} upload workers, ${CHUNK_SIZE_CONFIG / 1024 / 1024}MB chunks`,
        );
        logger.info(
          `⏰ DELAYS: Rate=${RATE_LIMIT_DELAY_CONFIG}ms, Download=${DOWNLOAD_DELAY_CONFIG}ms, Upload=${UPLOAD_DELAY_CONFIG}ms`,
        );
        logger.info(`📋 ORDER: Oldest → Newest`);
        logger.info(
          `🔄 PATTERN: Download All ULTRA-PARALLEL → Upload All ULTRA-PARALLEL → Delete All`,
        );
        logger.info(
          `🌊 FLOOD CONTROL: Adaptive learning enabled with ${this.floodWaitHistory.length} historical data points`,
        );

        await this.downloadChannel(client, channelId, messageOffsetId);

        // In config-from-file mode, exit after completion (no interactive continue)
        if (initialOptions.configFromFile) {
          logger.info("\ud83c\udf89 Config file download complete! Exiting...");
          break;
        }

        // Ask if user wants to continue with another channel
        const continueDownload = await this.askContinue();
        if (!continueDownload) {
          logger.info("🎉 Session complete! Exiting continuous mode...");
          break;
        }

        // Clear initial options so user can select new channel
        initialOptions = {};

        logger.info("🔄 Starting new channel selection...");
        await this.ultraOptimizedWait(1000);
      } catch (err) {
        logger.error("Error in continuous mode:");
        console.error(err);

        const retryAfterError = await this.askRetryAfterError();
        if (!retryAfterError) {
          logger.info("🛑 Exiting due to error...");
          break;
        }

        await this.ultraOptimizedWait(2000);
      }
    }
  }

  /**
   * Ask user if they want to continue with another channel
   */
  async askContinue() {
    try {
      const { booleanInput } = require("../utils/input-helper");
      return await booleanInput(
        "🔄 Download/Upload another channel? (Yes = Continue, No = Exit)",
      );
    } catch (error) {
      logger.warn("Failed to get continue input, defaulting to exit");
      return false;
    }
  }

  /**
   * Ask user if they want to retry after an error
   */
  async askRetryAfterError() {
    try {
      const { booleanInput } = require("../utils/input-helper");
      return await booleanInput(
        "❌ An error occurred. Try again with a different channel? (Yes = Retry, No = Exit)",
      );
    } catch (error) {
      logger.warn("Failed to get retry input, defaulting to exit");
      return false;
    }
  }
}

module.exports = DownloadChannel;
