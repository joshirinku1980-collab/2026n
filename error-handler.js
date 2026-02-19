class ErrorHandler {
    constructor() {
        this.retryAttempts = new Map();
        this.maxRetries = 3;
        this.retryDelay = 2000; // 2 seconds
        this.errorCounts = new Map();
    }

    // Wrap event handlers with error handling
    wrapHandler(handler) {
        return async (...args) => {
            try {
                return await handler(...args);
            } catch (error) {
                console.error('Handler error:', error);
                await this.handleGeneralError(error);
            }
        };
    }

    // Handle connection errors specifically  
    async handleConnectionError(error) {
        console.error('Connection error:', error);
        
        // Handle "Not connected" error
        if (error.message && error.message.includes('Not connected')) {
            console.log('🔄 Attempting to reconnect...');
            // Let the client handle reconnection automatically
            return;
        }
        
        // Handle other connection issues
        this.incrementErrorCount('connection');
        
        if (this.getErrorCount('connection') > 5) {
            console.error('❌ Multiple connection failures detected. Bot may need restart.');
        }
    }

    // Handle startup errors
    async handleStartupError(error) {
        console.error('❌ Startup error:', error);
        
        // Wait before retrying startup
        setTimeout(() => {
            console.log('🔄 Retrying bot startup...');
            process.exit(1); // Let process manager restart
        }, 5000);
    }

    // Handle message processing errors
    async handleMessageError(error, chatId = null) {
        console.error('Message processing error:', error);
        
        if (chatId) {
            try {
                await this.sendErrorNotification(chatId, 'Message processing failed', error);
            } catch (sendError) {
                console.error('Failed to send error notification:', sendError);
            }
        }
    }

    // Handle CLI output errors
    async handleOutputError(error, chatId = null) {
        console.error('Output processing error:', error);
        
        if (chatId) {
            try {
                await this.sendErrorNotification(chatId, 'Output processing failed', error);
            } catch (sendError) {
                console.error('Failed to send output error notification:', sendError);
            }
        }
    }

    // Handle process execution errors
    async handleProcessError(error, chatId = null) {
        console.error('Process execution error:', error);
        
        if (chatId) {
            try {
                await this.sendErrorNotification(chatId, 'Command execution failed', error);
            } catch (sendError) {
                console.error('Failed to send process error notification:', sendError);
            }
        }
    }

    // Handle execution errors
    async handleExecutionError(error, chatId = null) {
        console.error('Execution error:', error);
        
        if (chatId) {
            try {
                await this.sendErrorNotification(chatId, 'Execution failed', error);
            } catch (sendError) {
                console.error('Failed to send execution error notification:', sendError);
            }
        }
    }

    // Handle message sending errors
    async handleSendError(error, chatId = null) {
        console.error('Send error:', error);
        
        // Don't try to send error notification for send errors to avoid loops
        this.incrementErrorCount('send');
    }

    // Retry write operations with specific handling for error -122
    async retryWriteOperation(operation, chatId = null, operationId = null) {
        const id = operationId || Date.now().toString();
        const currentAttempts = this.retryAttempts.get(id) || 0;
        
        try {
            const result = await operation();
            
            // Success - clear retry count
            this.retryAttempts.delete(id);
            return result;
            
        } catch (error) {
            // Check for system error -122 specifically
            if (this.isSystemError122(error)) {
                return await this.handleSystemError122(operation, chatId, id, currentAttempts);
            }
            
            // Handle other write errors
            throw error;
        }
    }

    // Check if error is system error -122
    isSystemError122(error) {
        return error && (
            (error.errno === -122) ||
            (error.code === 'Unknown system error -122') ||
            (error.message && error.message.includes('system error -122')) ||
            (error.message && error.message.includes('Unknown system error -122'))
        );
    }

    // Handle system error -122 specifically
    async handleSystemError122(operation, chatId, operationId, currentAttempts) {
        console.log(`⚠️ System error -122 detected (attempt ${currentAttempts + 1}/${this.maxRetries})`);
        
        if (currentAttempts >= this.maxRetries) {
            // Max retries reached
            console.error('❌ Persistent write failure (system error -122). Giving up.');
            
            if (chatId) {
                try {
                    // Use a different method to send error notification
                    console.log('❌ Error: Persistent write failure (system error -122).');
                    console.log('Action: Skipped this write. Bot is still running.');
                } catch (notificationError) {
                    console.error('Failed to send error notification:', notificationError);
                }
            }
            
            this.retryAttempts.delete(operationId);
            return null; // Return null instead of throwing
        }
        
        // Increment retry count
        this.retryAttempts.set(operationId, currentAttempts + 1);
        
        // Send retry notification
        if (chatId && currentAttempts === 0) {
            try {
                console.log('⚠️ Warning: Write operation failed with system error -122.');
                console.log('Retrying in 5 seconds...');
            } catch (notificationError) {
                console.error('Failed to send retry notification:', notificationError);
            }
        }
        
        // Wait before retry (increasing delay)
        const delay = this.retryDelay * (currentAttempts + 1);
        await this.sleep(delay);
        
        // Retry the operation
        return await this.retryWriteOperation(operation, chatId, operationId);
    }

    // Handle uncaught exceptions
    async handleUncaughtException(error) {
        console.error('❌ Uncaught Exception:', error);
        
        // Check if it's the specific error we want to handle
        if (this.isSystemError122(error)) {
            console.log('🔄 Handling system error -122 in uncaught exception');
            // Don't crash the process for this specific error
            return;
        }
        
        // For other uncaught exceptions, log and continue
        console.error('🚨 Uncaught exception handled, bot continuing...');
    }

    // Handle unhandled rejections
    async handleUnhandledRejection(reason, promise) {
        console.error('❌ Unhandled Rejection:', reason);
        
        // Check if it's the specific error we want to handle
        if (this.isSystemError122(reason)) {
            console.log('🔄 Handling system error -122 in unhandled rejection');
            // Don't crash the process for this specific error
            return;
        }
        
        // For other unhandled rejections, log and continue
        console.error('🚨 Unhandled rejection handled, bot continuing...');
    }

    // Handle general errors
    async handleGeneralError(error) {
        console.error('General error:', error);
        this.incrementErrorCount('general');
    }

    // Send error notification to user
    async sendErrorNotification(chatId, context, error) {
        const errorMessage = `❌ ${context}: ${error.message || error}`;
        console.log(`Sending error notification: ${errorMessage}`);
        // Note: We're not actually sending to avoid circular dependencies
        // The calling code should handle the actual sending
    }

    // Increment error count for tracking
    incrementErrorCount(errorType) {
        const current = this.errorCounts.get(errorType) || 0;
        this.errorCounts.set(errorType, current + 1);
    }

    // Get error count
    getErrorCount(errorType) {
        return this.errorCounts.get(errorType) || 0;
    }

    // Reset error count
    resetErrorCount(errorType) {
        this.errorCounts.set(errorType, 0);
    }

    // Get all error statistics
    getErrorStats() {
        const stats = {};
        for (const [errorType, count] of this.errorCounts) {
            stats[errorType] = count;
        }
        return stats;
    }

    // Sleep utility
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Clear old retry attempts (cleanup)
    clearOldRetryAttempts() {
        // This could be called periodically to clean up old retry attempts
        // For now, we rely on successful operations to clear their own entries
    }
}

module.exports = ErrorHandler;
