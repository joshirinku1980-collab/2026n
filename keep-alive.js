const express = require('express');
const http = require('http');

class KeepAlive {
    constructor(bot) {
        this.bot = bot;
        this.app = express();
        this.server = null;
        this.port = 5000;
        this.status = 'Starting...';
        this.startTime = Date.now();
        this.requestCount = 0;
        
        this.setupRoutes();
    }

    setupRoutes() {
        // Main status endpoint for uptime monitoring
        this.app.get('/', (req, res) => {
            this.requestCount++;
            const uptime = this.getUptime();
            
            res.status(200).json({
                status: 'online',
                message: 'Bot is running',
                currentStatus: this.status,
                uptime: uptime,
                timestamp: new Date().toISOString(),
                requestCount: this.requestCount,
                version: '1.0.0'
            });
        });

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            this.requestCount++;
            res.status(200).json({
                status: 'healthy',
                uptime: this.getUptime(),
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage()
            });
        });

        // Status endpoint with HTML page
        this.app.get('/status', (req, res) => {
            this.requestCount++;
            const uptime = this.getUptime();
            
            const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telegram Bot Status</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
        }
        .container {
            background: rgba(255, 255, 255, 0.1);
            padding: 30px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            background: #4CAF50;
            border-radius: 50%;
            margin-right: 10px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        .metric {
            background: rgba(255, 255, 255, 0.1);
            padding: 15px;
            margin: 10px 0;
            border-radius: 8px;
        }
        .metric h3 {
            margin: 0 0 10px 0;
            color: #fff;
        }
        .metric p {
            margin: 5px 0;
            opacity: 0.9;
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
        }
        .last-updated {
            text-align: center;
            opacity: 0.7;
            font-size: 0.9em;
            margin-top: 20px;
        }
    </style>
    <script>
        // Auto-refresh every 30 seconds
        setTimeout(() => {
            window.location.reload();
        }, 30000);
    </script>
</head>
<body>
    <div class="container">
        <h1><span class="status-indicator"></span>Telegram Bot Status</h1>
        
        <div class="metric">
            <h3>🤖 Bot Status</h3>
            <p><strong>Status:</strong> ${this.status}</p>
            <p><strong>State:</strong> Online & Running</p>
        </div>
        
        <div class="metric">
            <h3>⏱️ Uptime</h3>
            <p><strong>Running for:</strong> ${uptime}</p>
            <p><strong>Started:</strong> ${new Date(this.startTime).toLocaleString()}</p>
        </div>
        
        <div class="metric">
            <h3>📊 Statistics</h3>
            <p><strong>Health checks:</strong> ${this.requestCount}</p>
            <p><strong>Last check:</strong> ${new Date().toLocaleString()}</p>
        </div>
        
        <div class="metric">
            <h3>🔧 System Info</h3>
            <p><strong>Memory Usage:</strong> ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
            <p><strong>Node Version:</strong> ${process.version}</p>
            <p><strong>Platform:</strong> ${process.platform}</p>
        </div>
        
        <div class="last-updated">
            Last updated: ${new Date().toLocaleString()}
            <br>
            <small>Page auto-refreshes every 30 seconds</small>
        </div>
    </div>
</body>
</html>`;
            
            res.send(html);
        });

        // Ping endpoint for simple monitoring
        this.app.get('/ping', (req, res) => {
            this.requestCount++;
            res.status(200).send('pong');
        });

        // API endpoint for external monitoring
        this.app.get('/api/status', (req, res) => {
            this.requestCount++;
            res.status(200).json({
                online: true,
                status: this.status,
                uptime: this.getUptimeSeconds(),
                timestamp: Date.now()
            });
        });

        // Catch all other routes
        this.app.use('*', (req, res) => {
            this.requestCount++;
            res.status(404).json({
                error: 'Endpoint not found',
                availableEndpoints: [
                    'GET /',
                    'GET /health',
                    'GET /status',
                    'GET /ping',
                    'GET /api/status'
                ]
            });
        });
    }

    start() {
        try {
            this.server = this.app.listen(this.port, '0.0.0.0', () => {
                console.log(`🌐 Keep-alive server running on http://0.0.0.0:${this.port}`);
                console.log(`📊 Status page: http://0.0.0.0:${this.port}/status`);
                console.log(`🏥 Health check: http://0.0.0.0:${this.port}/health`);
                this.updateStatus('Keep-alive server started');
            });

            this.server.on('error', (error) => {
                console.error('Keep-alive server error:', error);
                if (error.code === 'EADDRINUSE') {
                    console.log(`Port ${this.port} is in use, trying port ${this.port + 1}`);
                    this.port += 1;
                    this.start();
                }
            });

        } catch (error) {
            console.error('Failed to start keep-alive server:', error);
        }
    }

    stop() {
        if (this.server) {
            this.server.close(() => {
                console.log('Keep-alive server stopped');
            });
        }
    }

    updateStatus(newStatus) {
        this.status = newStatus;
        console.log(`📋 Status updated: ${newStatus}`);
    }

    getUptime() {
        const uptimeMs = Date.now() - this.startTime;
        const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
        const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);

        if (days > 0) {
            return `${days}d ${hours}h ${minutes}m ${seconds}s`;
        } else if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    getUptimeSeconds() {
        return Math.floor((Date.now() - this.startTime) / 1000);
    }
}

module.exports = KeepAlive;
