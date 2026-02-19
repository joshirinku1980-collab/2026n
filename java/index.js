
const ChannelDownloader = require("./scripts/download-channel");
const channelDownloader = new ChannelDownloader();

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  // Don't exit, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, just log the error
});

// Handle specific write stream errors
process.on('ENOSPC', () => {
  console.error('❌ No space left on device. Cleaning up...');
  // Trigger cleanup
  if (channelDownloader.cleanupMemory) {
    channelDownloader.cleanupMemory();
  }
});

// Parse CLI arguments for --config-json and --resume flags
const args = process.argv.slice(2);
let configFromFile = null;
let isResume = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config-json' && args[i + 1]) {
    try {
      const decoded = Buffer.from(args[i + 1], 'base64').toString('utf8');
      configFromFile = JSON.parse(decoded);
      console.log('📁 Config loaded from file upload');
      console.log(`   📥 Channel: ${configFromFile.channelId}`);
      console.log(`   📝 Mode: ${configFromFile.downloadMode}`);
      if (configFromFile.uploadChannel) {
        console.log(`   📤 Upload to: ${configFromFile.uploadChannel}`);
      }
    } catch (err) {
      console.error('❌ Failed to parse --config-json:', err.message);
    }
    i++; // Skip value arg
  } else if (args[i] === '--resume') {
    isResume = true;
  }
}

// Enhanced configuration to support all message types
const channelId = ""; // Leave empty to select interactively
const downloadableFiles = {
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
  rar: true,
  txt: true,
  docx: true,
  xlsx: true,
  pptx: true,
  mp3: true,
  mp4: true,
  avi: true,
  mkv: true,
  gif: true,
  webm: true,
  all: true // Download all file types
};

(async () => {
  try {
    console.log("🚀 Enhanced Telegram Channel Downloader - CONTINUOUS MODE");
    console.log("📋 Features:");
    console.log("   ✅ Downloads ALL message types (text, media, stickers, documents)");
    console.log("   ✅ Maintains original captions");
    console.log("   ✅ Optional upload to another channel");
    console.log("   ✅ Parallel processing (35+ Mbps target speed)");
    console.log("   ✅ Rate limiting and flood protection");
    console.log("   ✅ Auto cleanup after upload");
    console.log("   ✅ Progress tracking");
    console.log("   ✅ CONTINUOUS MODE: Download multiple channels without re-login");
    if (configFromFile) {
      console.log("   ✅ CONFIG FILE MODE: Auto-configured from uploaded text file");
    }
    console.log("");

    // Build options with config if available
    const handleOptions = { channelId, downloadableFiles };
    if (configFromFile) {
      handleOptions.configFromFile = configFromFile;
    }
    if (isResume) {
      handleOptions.resume = true;
    }

    await channelDownloader.handle(handleOptions);
  } catch (err) {
    console.error("❌ Fatal error:", err);
  }
})();
