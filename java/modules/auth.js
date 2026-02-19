const { TelegramClient } = require("telegram");
const { updateCredentials, getCredentials } = require("../utils/file-helper");
const { StringSession } = require("telegram/sessions");
const { logMessage } = require("../utils/helper");

const {
  textInput,
  mobileNumberInput,
  otpInput,
  selectInput,
} = require("../utils/input-helper");

// Global variable to store bot context for session sharing
let globalBotContext = null;

// Function to set bot context from main bot
const setBotContext = (ctx) => {
  globalBotContext = ctx;
};

// Function to send session ID to user via bot
const sendSessionToUser = async (sessionId) => {
  if (globalBotContext && sessionId) {
    try {
      const message = `🔑 Your Session ID (save this for future logins):\n\n\`${sessionId}\`\n\n⚠️ Keep this private! You can use this to login without OTP next time by selecting "Login with Session ID" option.`;
      await globalBotContext.reply(message, { parse_mode: 'Markdown' });
      console.log("✅ Session ID sent to user via bot");
    } catch (error) {
      console.log("⚠️ Could not send session ID via bot:", error.message);
    }
  }
};

const OTP_METHOD = {
  SMS: "sms",
  APP: "app",
};

let { apiHash, apiId, sessionId } = getCredentials();
const stringSession = new StringSession(sessionId || "");

/**
 * Initializes the authentication process for the Telegram client.
 * @param {string} [otpPreference=OTP_METHOD.APP] - The preferred method for receiving the OTP (either 'app' or 'sms').
 * @param {number} [securityRetryCount=0] - Number of security error retries attempted.
 * @returns {Promise<TelegramClient>} - The authenticated Telegram client.
 */
const initAuth = async (otpPreference = OTP_METHOD.APP, securityRetryCount = 0, loginMethod = null) => {
  // Auto-detect saved session if --resume flag is present
  const isResume = process.argv.includes('--resume');
  
  // Try saved session first if it exists
  if (sessionId && sessionId.length > 10 && securityRetryCount === 0) {
    try {
      console.log("🔄 Found saved session ID - Attempting auto-login...");
      const savedSessionString = new StringSession(sessionId);
      const sessionClient = new TelegramClient(savedSessionString, apiId, apiHash, {
        connectionRetries: 5,
      });

      await sessionClient.connect();
      
      // Test if saved session is valid
      try {
        const me = await sessionClient.getMe();
        console.log(`✅ Auto-login successful! Welcome back, ${me.firstName || 'User'}`);
        console.log("🚀 Proceeding directly to channel selection...");
        
        return sessionClient;
      } catch (testError) {
        console.log("⚠️ Saved session expired or invalid. Clearing and requesting new login...");
        await sessionClient.disconnect();
        // Clear the invalid session
        sessionId = "";
        updateCredentials({ sessionId: "" });
        // Fall through to manual login
      }
    } catch (sessionError) {
      console.log("⚠️ Auto-login failed:", sessionError.message);
      console.log("🔄 Proceeding to manual login...");
      // Clear the invalid session
      sessionId = "";
      updateCredentials({ sessionId: "" });
    }
  }
  
  // Only ask for login method if we don't have a valid session AND not resuming
  if (!loginMethod && securityRetryCount === 0 && (!sessionId || sessionId.length <= 10)) {
    // If resume flag is set but no valid session, force OTP login without asking
    if (isResume) {
      console.log("🔄 Resume flag detected but no valid session - Using OTP login...");
      loginMethod = "otp";
    } else {
      // Normal flow: ask user for login method
      const loginOptions = [
        { name: "🔐 Login with OTP (Phone verification)", value: "otp" },
        { name: "🗝️ Login with Session ID (Quick login)", value: "session" }
      ];
      
      loginMethod = await selectInput("Choose login method:", loginOptions);
    }
  }

  // Handle session ID login
  if (loginMethod === "session" && securityRetryCount === 0) {
    try {
      const sessionIdInput = await textInput("Enter your Session ID:");
      if (sessionIdInput && sessionIdInput.trim().length > 10) {
        console.log("🔄 Attempting login with provided Session ID...");
        const sessionStringFromInput = new StringSession(sessionIdInput.trim());
        const sessionClient = new TelegramClient(sessionStringFromInput, apiId, apiHash, {
          connectionRetries: 5,
        });

        await sessionClient.connect();
        
        // Test if session is valid
        try {
          const me = await sessionClient.getMe();
          console.log(`✅ Session login successful! Welcome back, ${me.firstName || 'User'}`);
          
          // Update stored session
          sessionId = sessionIdInput.trim();
          updateCredentials({ sessionId });
          
          return sessionClient;
        } catch (testError) {
          console.log("❌ Invalid or expired Session ID. Falling back to OTP login...");
          await sessionClient.disconnect();
          // Fall through to OTP login
        }
      } else {
        console.log("❌ Invalid Session ID format. Falling back to OTP login...");
      }
    } catch (sessionError) {
      console.log("❌ Session login failed:", sessionError.message);
      console.log("🔄 Falling back to OTP login...");
    }
    
    // Reset to OTP login if session login fails
    loginMethod = "otp";
  }
  // Generate random device configuration for security error recovery
  const generateRandomDeviceConfig = () => {
    const deviceConfigs = [
      {
        deviceModel: "Samsung Galaxy S24 Ultra",
        systemVersion: "Android 14",
        appVersion: "10.14.5",
        langCode: "en",
        systemLangCode: "en-US",
      },
      {
        deviceModel: "iPhone 15 Pro Max",
        systemVersion: "iOS 17.2",
        appVersion: "10.2.1",
        langCode: "en",
        systemLangCode: "en-US",
      },
      {
        deviceModel: "Google Pixel 8 Pro", 
        systemVersion: "Android 14",
        appVersion: "10.14.3",
        langCode: "en",
        systemLangCode: "en-US",
      },
      {
        deviceModel: "OnePlus 12",
        systemVersion: "Android 14",
        appVersion: "10.14.4",
        langCode: "en", 
        systemLangCode: "en-US",
      }
    ];

    return deviceConfigs[Math.floor(Math.random() * deviceConfigs.length)];
  };

  // Use random device config if this is a security retry
  const clientConfig = securityRetryCount > 0 ? {
    connectionRetries: 5,
    ...generateRandomDeviceConfig(),
    useIPv6: Math.random() > 0.5, // Randomly use IPv6
    tcpNoDelay: Math.random() > 0.5, // Random TCP settings
  } : {
    connectionRetries: 5,
  };

  console.log(`🔄 Attempt ${securityRetryCount + 1} - Device: ${clientConfig.deviceModel || 'Default'}`);

  const client = new TelegramClient(
    securityRetryCount > 0 ? new StringSession("") : stringSession, 
    apiId, 
    apiHash, 
    clientConfig
  );

  try {
    if (!sessionId) {
      otpPreference = await selectInput("Where do you want the login OTP:", [
        OTP_METHOD.APP,
        OTP_METHOD.SMS,
      ]);
    }

    const forceSMS = otpPreference === OTP_METHOD.SMS;

    await client.start({
      phoneNumber: async () => await mobileNumberInput(),
      password: async () => await textInput("Enter your password"),
      phoneCode: async (isCodeViaApp) => {
        logMessage.info(`OTP sent over ${isCodeViaApp ? "APP" : "SMS"}`);

        return await otpInput();
      },
      forceSMS,
      onError: (err) => {
        logMessage.error(err);

        // Enhanced error handling for PHONE_NUMBER_BANNED
        if (err.message && err.message.includes("PHONE_NUMBER_BANNED")) {
          console.log("\n🚨 PHONE NUMBER BANNED FOR API ACCESS 🚨");
          console.log("=====================================");
          console.log("❌ This phone number is banned from Telegram API access.");
          console.log("✅ Note: You can still use regular Telegram apps normally.");
          console.log("");
          console.log("🔧 ATTEMPTING DEVICE SPOOFING SOLUTIONS:");
          console.log("1. Clearing session to appear as new device...");
          console.log("2. Changing device model and system info...");
          console.log("3. Using different connection parameters...");
          console.log("");

          // Try device spoofing approach
          console.log("🔄 Attempting device reset...");
          sessionId = ""; // Clear session
          updateCredentials({ sessionId: "" }); // Save cleared session

          // Create new client with different device info
          const newDeviceConfig = {
            connectionRetries: 5,
            deviceModel: `iPhone 15 Pro`,
            systemVersion: "iOS 17.1",
            appVersion: "10.2.1",
            langCode: "en",
            systemLangCode: "en-US",
            useIPv6: true, // Try different network stack
            tcpNoDelay: false, // Different TCP settings
          };

          console.log("🔄 Retrying with spoofed device information...");
          const newClient = new TelegramClient(new StringSession(""), apiId, apiHash, newDeviceConfig);

          // Return the new client for retry
          throw new Error("DEVICE_RESET_ATTEMPT: Trying with new device configuration");
        }

        // Handle SecurityError and authentication issues
        if (err.message && (err.message.includes("SecurityError") || err.message.includes("invalid new nonce hash"))) {
          console.log("\n🔐 TELEGRAM SECURITY ERROR DETECTED 🔐");
          console.log("=======================================");
          console.log("❌ Telegram detected authentication security issues:");
          console.log("   • Login code was shared or compromised");
          console.log("   • Authentication nonce hash validation failed");
          console.log("   • Telegram blocked the login for security reasons");
          console.log("");
          console.log("🔧 AUTOMATIC RECOVERY SOLUTIONS:");
          console.log("1. Clearing all session data...");
          console.log("2. Resetting device fingerprint...");
          console.log("3. Using fresh authentication flow...");
          console.log("");

          // Clear all session data
          sessionId = "";
          updateCredentials({ sessionId: "" });

          // Generate random device info to appear as completely new device
          const deviceModels = [
            "Samsung Galaxy S24 Ultra",
            "iPhone 15 Pro Max", 
            "Google Pixel 8 Pro",
            "OnePlus 12",
            "Xiaomi 14 Pro"
          ];
          
          const systemVersions = [
            "Android 14",
            "iOS 17.2", 
            "Android 13",
            "iOS 16.7",
            "Android 12"
          ];

          const randomDevice = deviceModels[Math.floor(Math.random() * deviceModels.length)];
          const randomSystem = systemVersions[Math.floor(Math.random() * systemVersions.length)];

          console.log(`🔄 Generating new device identity: ${randomDevice} (${randomSystem})`);

          throw new Error("SECURITY_ERROR_RECOVERY: Authentication blocked by Telegram security. Complete session reset required.");
        }

        // Handle PHONE_CODE_EXPIRED
        if (err.message && err.message.includes("PHONE_CODE_EXPIRED")) {
          console.log("\n⏰ LOGIN CODE EXPIRED ⏰");
          console.log("========================");
          console.log("❌ The OTP code has expired.");
          console.log("🔄 Please request a new code and try again.");
          console.log("");
          
          throw new Error("PHONE_CODE_EXPIRED: The login code has expired. Please restart the authentication process.");
        }
      },
    });

    logMessage.success("You should now be connected.");

    // Always save/update session ID after successful connection
    const newSessionId = client.session.save();
    if (!sessionId || sessionId !== newSessionId) {
      sessionId = newSessionId;
      updateCredentials({ sessionId: newSessionId });
      logMessage.info(
        "✅ Session ID saved to config.json for future auto-login."
      );
      
      // Send session ID to user via bot for future use
      await sendSessionToUser(sessionId);
    }

    return client;
  } catch (err) {
    logMessage.error(err);

    // Handle security errors with automatic retry
    if (err.message && (
      err.message.includes("SecurityError") || 
      err.message.includes("invalid new nonce hash") ||
      err.message.includes("SECURITY_ERROR_RECOVERY") ||
      err.message.includes("PHONE_CODE_EXPIRED")
    )) {
      if (securityRetryCount < 3) {
        console.log(`\n🔄 AUTOMATIC SECURITY ERROR RECOVERY 🔄`);
        console.log(`============================================`);
        console.log(`❌ Security error detected (attempt ${securityRetryCount + 1}/3)`);
        console.log(`🔧 Implementing automatic recovery:`);
        console.log(`   • Clearing all session data`);
        console.log(`   • Generating new device fingerprint`);
        console.log(`   • Using fresh authentication flow`);
        console.log(`   • Waiting 10 seconds for Telegram cooldown`);
        console.log(``);

        // Clear session completely
        sessionId = "";
        updateCredentials({ sessionId: "" });

        // Wait for Telegram's security cooldown
        await new Promise(resolve => setTimeout(resolve, 10000));

        console.log(`🚀 Retrying authentication with fresh security context...`);

        // Retry with incremented counter and fresh session
        return await initAuth(otpPreference, securityRetryCount + 1);
      } else {
        console.log(`\n🚨 MAXIMUM SECURITY RETRIES REACHED 🚨`);
        console.log(`=====================================`);
        console.log(`❌ Authentication failed after 3 attempts.`);
        console.log(`🔐 Telegram has blocked this authentication session.`);
        console.log(``);
        console.log(`💡 MANUAL SOLUTIONS REQUIRED:`);
        console.log(`1. ⏰ Wait 1-2 hours before trying again`);
        console.log(`2. 📱 Use a different phone number`);
        console.log(`3. 🌐 Try from a different network/IP address`);
        console.log(`4. 🔄 Restart the entire bot and try again`);
        console.log(`5. 🛡️ Never share login codes with anyone`);
        console.log(``);
        console.log(`⚠️  This is Telegram's anti-abuse protection working.`);
        
        throw new Error("AUTHENTICATION_BLOCKED: Maximum security retries reached. Wait 1-2 hours and try again with fresh session.");
      }
    }

    // Handle device reset attempts
    if (err.message && err.message.includes("DEVICE_RESET_ATTEMPT")) {
      if (securityRetryCount < 2) {
        console.log(`🔄 Retrying with device reset (attempt ${securityRetryCount + 1})...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return await initAuth(otpPreference, securityRetryCount + 1);
      }
    }

    throw err;
  }
};

module.exports = {
  initAuth,
  setBotContext,
  sendSessionToUser,
};