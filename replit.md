# Telegram Bot with Java Channel Downloader

## Overview

This project is a Telegram bot that integrates with a Java-based Telegram channel downloader. The bot serves as an interface for users to interact with the channel downloading functionality, while the Java component handles the heavy lifting of downloading media and messages from Telegram channels. The system is designed for high-speed downloads with optimizations for consistent 30+ Mbps performance.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Bot Architecture
- **Telegraf Framework**: Uses the Telegraf library for Telegram bot API interactions
- **Express Server**: Runs an Express.js server for health checks and keep-alive functionality
- **Session Management**: Maintains user sessions in memory using Maps for tracking progress and state
- **Rate Limiting**: Implements sophisticated rate limiting to prevent Telegram API abuse
- **Error Handling**: Comprehensive error handling with retry mechanisms and graceful degradation

### Channel Downloader Architecture
- **Telegram Client**: Uses the `telegram` library for direct MTProto connections
- **Authentication Module**: Handles Telegram API authentication with session management
- **Download Engine**: Ultra-optimized download system targeting 30+ Mbps speeds with:
  - Parallel downloads (32 workers)
  - Large chunk sizes (32MB)
  - Batch processing
  - Connection pooling
- **Media Processing**: Supports all Telegram media types including images, videos, documents, stickers, etc.
- **Progress Tracking**: Real-time progress monitoring with speed calculations

### Core Components

#### Bot Core (`bot.js`)
- Main bot entry point with command handlers
- Progress tracking for download operations
- Speed monitoring integration
- User session state management

#### Channel Downloader (`java/scripts/download-channel.js`)
- High-performance channel downloading with aggressive optimization
- Support for selective media type downloading
- Batch processing with configurable limits
- Ultra-fast parallel processing capabilities
- **NEW: Channel comparison and sync feature** - compares two channels and syncs missing files

#### Authentication System (`java/modules/auth.js`)
- Telegram API authentication handling
- Session ID management and storage
- OTP verification support
- Bot integration for session sharing

#### Message Processing (`java/modules/messages.js`)
- Message fetching and filtering
- Media download optimization
- File upload capabilities
- Message forwarding support

### Design Patterns
- **Module Pattern**: Clear separation of concerns across modules
- **Factory Pattern**: Dynamic command loading system
- **Observer Pattern**: Progress tracking and real-time updates
- **Singleton Pattern**: Global bot context and session management

### Features

#### Feature 1: Download All Messages
- Downloads all messages from a channel with ULTRA-SPEED optimization (35+ Mbps target)
- Processes all media types including images, videos, documents, stickers, etc.
- Optional upload to another channel

#### Feature 2: Download Specific Messages
- Downloads only user-specified message IDs
- Supports comma-separated list of message IDs
- Same ULTRA-SPEED performance

#### Feature 3: Download From Message to End
- Starts downloading from a specific message ID and continues to the end
- Useful for resuming interrupted downloads
- Maintains ULTRA-SPEED performance

#### Feature 4: Compare and Sync Channels (NEW)
- **Intelligent Channel Comparison**: Scans both source and target channels in batches of 500 messages
- **Tiered Matching Algorithm**:
  - Priority 1: Full caption/text match with media type verification
  - Priority 2: File name match with media type and file size verification
  - Priority 3: Metadata-based matching for edge cases
- **Differential Sync**: Only downloads and uploads missing files
- **Batch Processing**: Scans channels in 500-message batches for memory efficiency
- **Progress Tracking**: Real-time reporting of scanning, comparison, and sync progress
- **All Media Support**: Handles all Telegram message types (media, text, stickers, documents, etc.)

### Performance Optimizations
- **Connection Pooling**: Multiple concurrent connections for stability
- **Chunk Optimization**: Large chunk sizes (32MB) for maximum throughput
- **Parallel Processing**: Up to 32 parallel downloads/uploads
- **Minimal Delays**: Ultra-low delays (20-50ms) between operations
- **Batch Processing**: Efficient batch handling for multiple files
- **Memory-Efficient Scanning**: 500-message batch processing for large channels

### Data Management
- **File System Storage**: Local file storage for downloaded media
- **JSON Configuration**: Configuration management through JSON files
- **Session Persistence**: Session data stored in JSON format
- **Export System**: HTML and JSON export capabilities for channel data

## External Dependencies

### Core Libraries
- **telegraf**: Telegram bot framework for API interactions
- **telegram**: Direct MTProto client for high-performance operations
- **express**: Web server for health checks and monitoring

### Utility Libraries
- **inquirer**: Interactive command-line prompts
- **ejs**: Template engine for HTML exports
- **glob**: File pattern matching
- **mime-db**: MIME type detection for media files

### Development Tools
- **nodemon**: Development server with auto-reload functionality

### External Services
- **Telegram API**: Primary integration for bot functionality and channel access
- **MTProto Protocol**: Direct protocol access for optimized performance

### Configuration Requirements
- **Telegram Bot Token**: Required for bot authentication
- **Telegram API Credentials**: API ID and hash for client authentication
- **Session Management**: Telegram session strings for persistent authentication

The system is designed to handle high-volume downloads while maintaining stability and providing real-time feedback to users through the Telegram bot interface.