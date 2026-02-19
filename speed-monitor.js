const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class SpeedMonitor {
    constructor() {
        this.isMonitoring = false;
        this.networkInterfaces = [];
        this.previousStats = null;
        this.currentStats = null;
        this.monitoringInterval = null;
        this.monitoringStartTime = null;
        
        this.initializeNetworkInterfaces();
    }

    async initializeNetworkInterfaces() {
        try {
            // Get available network interfaces
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            // Get network interface names (excluding loopback)
            const { stdout } = await execAsync("ls /sys/class/net/ | grep -v lo");
            this.networkInterfaces = stdout.trim().split('\n').filter(iface => iface.trim());
            
            console.log('Available network interfaces:', this.networkInterfaces);
        } catch (error) {
            console.warn('Could not detect network interfaces, using default:', error.message);
            this.networkInterfaces = ['eth0', 'wlan0', 'ens33'];
        }
    }

    startMonitoring() {
        if (this.isMonitoring) {
            return;
        }

        this.isMonitoring = true;
        this.monitoringStartTime = Date.now();
        
        // Get initial network stats
        this.updateNetworkStats();
        
        // Update stats every 5 seconds for accurate speed calculation
        this.monitoringInterval = setInterval(() => {
            this.updateNetworkStats();
        }, 5000);
        
        console.log('📡 Speed monitoring started');
    }

    stopMonitoring() {
        if (!this.isMonitoring) {
            return;
        }

        this.isMonitoring = false;
        
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        
        this.previousStats = null;
        this.currentStats = null;
        
        console.log('📡 Speed monitoring stopped');
    }

    async updateNetworkStats() {
        try {
            const newStats = await this.getNetworkStats();
            
            if (newStats) {
                this.previousStats = this.currentStats;
                this.currentStats = newStats;
            }
        } catch (error) {
            console.warn('Failed to update network stats:', error.message);
        }
    }

    async getNetworkStats() {
        try {
            const stats = {
                timestamp: Date.now(),
                interfaces: {}
            };

            // Read network statistics from /proc/net/dev
            const netDevData = await this.readFile('/proc/net/dev');
            const lines = netDevData.split('\n');
            
            for (let i = 2; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const parts = line.split(/\s+/);
                if (parts.length < 17) continue;
                
                const interfaceName = parts[0].replace(':', '');
                
                // Skip loopback and inactive interfaces
                if (interfaceName === 'lo' || !this.networkInterfaces.includes(interfaceName)) {
                    continue;
                }
                
                stats.interfaces[interfaceName] = {
                    rxBytes: parseInt(parts[1]) || 0,
                    txBytes: parseInt(parts[9]) || 0,
                    rxPackets: parseInt(parts[2]) || 0,
                    txPackets: parseInt(parts[10]) || 0
                };
            }
            
            return stats;
        } catch (error) {
            // Fallback to alternative method if /proc/net/dev is not available
            return await this.getNetworkStatsAlternative();
        }
    }

    async getNetworkStatsAlternative() {
        try {
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            const stats = {
                timestamp: Date.now(),
                interfaces: {}
            };
            
            // Use ip command to get network statistics
            for (const iface of this.networkInterfaces) {
                try {
                    const { stdout } = await execAsync(`ip -s link show ${iface}`);
                    const lines = stdout.split('\n');
                    
                    // Parse RX stats
                    const rxLine = lines.find(line => line.includes('RX:'));
                    const txLine = lines.find(line => line.includes('TX:'));
                    
                    if (rxLine && txLine) {
                        const rxMatch = rxLine.match(/(\d+)\s+(\d+)/);
                        const txMatch = txLine.match(/(\d+)\s+(\d+)/);
                        
                        if (rxMatch && txMatch) {
                            stats.interfaces[iface] = {
                                rxBytes: parseInt(rxMatch[1]) || 0,
                                txBytes: parseInt(txMatch[1]) || 0,
                                rxPackets: parseInt(rxMatch[2]) || 0,
                                txPackets: parseInt(txMatch[2]) || 0
                            };
                        }
                    }
                } catch (ifaceError) {
                    // Interface might not exist, continue with others
                    continue;
                }
            }
            
            return stats;
        } catch (error) {
            console.warn('Alternative network stats method failed:', error.message);
            return null;
        }
    }

    async readFile(filePath) {
        return new Promise((resolve, reject) => {
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    async getCurrentSpeed() {
        if (!this.isMonitoring || !this.previousStats || !this.currentStats) {
            return {
                download: '0.0',
                upload: '0.0',
                total: '0.0',
                duration: 0
            };
        }

        try {
            const timeDiff = (this.currentStats.timestamp - this.previousStats.timestamp) / 1000; // seconds
            
            if (timeDiff <= 0) {
                return {
                    download: '0.0',
                    upload: '0.0',
                    total: '0.0',
                    duration: 0
                };
            }

            let totalRxBytes = 0;
            let totalTxBytes = 0;

            // Sum up all active interfaces
            for (const interfaceName of this.networkInterfaces) {
                const currentIface = this.currentStats.interfaces[interfaceName];
                const previousIface = this.previousStats.interfaces[interfaceName];
                
                if (currentIface && previousIface) {
                    const rxDiff = currentIface.rxBytes - previousIface.rxBytes;
                    const txDiff = currentIface.txBytes - previousIface.txBytes;
                    
                    // Only count positive differences (avoid counter resets)
                    if (rxDiff >= 0) totalRxBytes += rxDiff;
                    if (txDiff >= 0) totalTxBytes += txDiff;
                }
            }

            // Calculate speeds in MB/s
            const downloadSpeed = (totalRxBytes / timeDiff) / (1024 * 1024); // MB/s
            const uploadSpeed = (totalTxBytes / timeDiff) / (1024 * 1024); // MB/s
            const totalSpeed = downloadSpeed + uploadSpeed;

            return {
                download: downloadSpeed.toFixed(1),
                upload: uploadSpeed.toFixed(1),
                total: totalSpeed.toFixed(1),
                duration: Math.floor((Date.now() - this.monitoringStartTime) / 1000)
            };
        } catch (error) {
            console.warn('Failed to calculate current speed:', error.message);
            return {
                download: '0.0',
                upload: '0.0', 
                total: '0.0',
                duration: 0
            };
        }
    }

    async getDetailedStats() {
        const speed = await this.getCurrentSpeed();
        const totalDuration = this.monitoringStartTime ? 
            Math.floor((Date.now() - this.monitoringStartTime) / 1000) : 0;
        
        return {
            speed,
            monitoring: {
                isActive: this.isMonitoring,
                duration: totalDuration,
                startTime: this.monitoringStartTime,
                interfaces: this.networkInterfaces.length
            },
            interfaces: this.currentStats ? Object.keys(this.currentStats.interfaces) : []
        };
    }
}

module.exports = SpeedMonitor;
