class RateLimiter {
    constructor(delayMs = 5000) {
        this.delayMs = delayMs;
        this.lastMessageTime = 0;
        this.messageQueue = [];
        this.isProcessingQueue = false;
    }

    // Wait if needed to respect rate limit
    async waitIfNeeded() {
        const now = Date.now();
        const timeSinceLastMessage = now - this.lastMessageTime;
        
        if (timeSinceLastMessage < this.delayMs) {
            const waitTime = this.delayMs - timeSinceLastMessage;
            console.log(`⏳ Rate limiting: waiting ${waitTime}ms before next message`);
            await this.sleep(waitTime);
        }
        
        this.lastMessageTime = Date.now();
    }

    // Add message to queue (alternative approach)
    addToQueue(messageFunction) {
        return new Promise((resolve, reject) => {
            this.messageQueue.push({
                messageFunction,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            this.processQueue();
        });
    }

    // Process message queue with rate limiting
    async processQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        try {
            while (this.messageQueue.length > 0) {
                const { messageFunction, resolve, reject } = this.messageQueue.shift();
                
                try {
                    // Apply rate limiting
                    await this.waitIfNeeded();
                    
                    // Execute the message function
                    const result = await messageFunction();
                    resolve(result);
                    
                } catch (error) {
                    reject(error);
                }
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    // Get current queue status
    getQueueStatus() {
        return {
            queueLength: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            lastMessageTime: this.lastMessageTime,
            delayMs: this.delayMs
        };
    }

    // Update rate limit delay
    setDelay(newDelayMs) {
        this.delayMs = newDelayMs;
        console.log(`📝 Rate limit delay updated to ${newDelayMs}ms`);
    }

    // Clear the queue (emergency use)
    clearQueue() {
        const clearedCount = this.messageQueue.length;
        
        // Reject all pending messages
        this.messageQueue.forEach(({ reject }) => {
            reject(new Error('Queue cleared'));
        });
        
        this.messageQueue = [];
        console.log(`🗑️ Cleared ${clearedCount} messages from rate limit queue`);
        
        return clearedCount;
    }

    // Sleep utility
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Get statistics
    getStats() {
        const now = Date.now();
        const timeSinceLastMessage = now - this.lastMessageTime;
        
        return {
            delayMs: this.delayMs,
            queueLength: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            lastMessageTime: this.lastMessageTime,
            timeSinceLastMessage,
            canSendImmediately: timeSinceLastMessage >= this.delayMs
        };
    }

    // Calculate optimal delay based on message frequency
    adaptiveDelay(messageCount, timeWindow = 60000) {
        // Adjust delay based on message frequency
        const messagesPerMinute = messageCount / (timeWindow / 60000);
        
        if (messagesPerMinute > 10) {
            this.setDelay(7000); // Increase delay for high frequency
        } else if (messagesPerMinute > 5) {
            this.setDelay(5000); // Standard delay
        } else {
            this.setDelay(3000); // Reduce delay for low frequency
        }
    }
}

module.exports = RateLimiter;
