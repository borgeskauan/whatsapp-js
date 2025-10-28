# WhatsApp.js

A Node.js-based WhatsApp automation/integration project that allows you to interact with WhatsApp programmatically. Built using the [Baileys](https://github.com/WhiskeySockets/Baileys) library, this project provides a simple HTTP API to interact with WhatsApp.

## API Endpoints

The server exposes the following endpoints on port 3000 by default:

### Status Endpoints
- `GET /status` - Get the current connection status
  - Returns: `{ connected: boolean, me: Object, hasQR: boolean }`

### Authentication
- `GET /qr.png` - Get the QR code as a PNG image for WhatsApp Web authentication
  - Returns a PNG image when QR is available
  - Returns 204 No Content when already connected

### Real-time Updates
- `GET /events` - Server-Sent Events (SSE) endpoint for real-time updates
  - Provides live updates for:
    - QR code updates
    - Connection status changes
    - New incoming messages
  - Events are pushed to the client in real-time

### Messages
- `GET /messages` - Get recent messages
  - Query Parameters:
    - `limit` (optional): Number of messages to return (default: 50, max: 200)
  - Returns an array of recent messages

- `POST /send` - Send a text message
  - Body:
    ```json
    {
      "to": "phone_number_or_jid",
      "message": "text_message"
    }
    ```
  - The `to` field can be either:
    - A phone number (e.g., "1234567890")
    - A JID (e.g., "1234567890@s.whatsapp.net")
  - Returns:
    ```json
    {
      "ok": true,
      "id": "message_id",
      "to": "normalized_jid"
    }
    ```

## Project Structure

```
├── src/
│   └── server.js        # Main server implementation
├── wa-auth/             # WhatsApp authentication files
├── docker-compose.yml   # Docker composition configuration
├── Dockerfile          # Docker container configuration
└── sample-commands.sh  # Example usage commands
```

## Prerequisites

- Node.js
- Docker (optional, for containerized deployment)

## Getting Started

1. Clone the repository:
```bash
git clone https://github.com/borgeskauan/whatsapp-js.git
cd whatsapp-js
```

2. Install dependencies:
```bash
npm install
```

3. Start the application:

Using Node.js directly:
```bash
npm start
```

Using Docker:
```bash
docker-compose up
```

## Docker Support

The project includes Docker support for containerized deployment:

- `Dockerfile`: Contains the container configuration
- `docker-compose.yml`: Defines the service configuration and dependencies

To run using Docker Compose:
```bash
docker-compose up -d
```

## Authentication

WhatsApp authentication data is stored in the `wa-auth/` directory. This includes:
- Session data
- Device information
- Pre-keys for encryption
- State synchronization data

Make sure to properly handle these authentication files as they contain sensitive information.

**Note**: If you want to reconnect to a different WhatsApp number, you can safely delete all contents of the `wa-auth/` directory. The next time you start the application, it will generate a new QR code for authentication with a different number.